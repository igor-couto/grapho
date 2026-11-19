//! Backup connectors.
//!
//! A connector is a second place that receives a copy of every document after a
//! save: a folder on this machine, an SSH server reached through the system SFTP
//! client, or a Google Drive folder. Mirroring runs on one worker task, never on
//! the request path: a save is acknowledged as soon as the primary folder has it,
//! so a slow network cannot slow down typing. The worker always reads the latest
//! version from the store, so a burst of saves collapses into one write per
//! document instead of one per save.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::{mpsc, oneshot, RwLock};
use tokio::time::timeout;
use uuid::Uuid;

use crate::drive::{Credentials, Drive};
use crate::secrets::Secrets;
use crate::settings::{BackupLocation, BackupTarget};
use crate::sftp::{self, Target as SftpTarget};
use crate::store::{self, SharedStore};

/// Why a backup connector was refused. The HTTP layer turns these into messages
/// a person can act on.
#[derive(Debug)]
pub enum BackupError {
    NotAbsolute,
    SameAsDataFolder,
    InsideDataFolder,
    ContainsDataFolder,
    AlreadyABackup,
    Occupied {
        documents: usize,
    },
    /// One of the remote fields cannot work; the message says which.
    Invalid {
        message: String,
    },
    Io {
        path: PathBuf,
        message: String,
    },
    /// The SFTP client refused or failed; the message is its own complaint.
    Ssh {
        message: String,
    },
    /// Google Drive refused or failed.
    Google {
        message: String,
    },
}

impl BackupError {
    fn io(path: &Path, error: impl std::fmt::Display) -> Self {
        Self::Io {
            path: path.to_path_buf(),
            message: error.to_string(),
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::Invalid {
            message: message.into(),
        }
    }
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAbsolute => write!(formatter, "{}", full_path_message()),
            Self::SameAsDataFolder | Self::InsideDataFolder => {
                write!(formatter, "Choose a folder outside the data folder.")
            }
            Self::ContainsDataFolder => {
                write!(
                    formatter,
                    "Choose a folder that doesn't contain the data folder."
                )
            }
            Self::AlreadyABackup => write!(formatter, "That backup already exists."),
            Self::Occupied { documents } => {
                let what = if *documents == 1 {
                    "a document from another Grapho library".to_owned()
                } else {
                    format!("{documents} documents from another Grapho library")
                };
                write!(
                    formatter,
                    "That folder already holds {what}. Choose an empty folder."
                )
            }
            Self::Invalid { message } => write!(formatter, "{message}"),
            Self::Io { path, message } => {
                write!(
                    formatter,
                    "Grapho couldn't write to {}: {message}",
                    path.display()
                )
            }
            Self::Ssh { message } => write!(formatter, "SSH backup failed: {message}"),
            Self::Google { message } => write!(formatter, "Google Drive backup failed: {message}"),
        }
    }
}

fn full_path_message() -> &'static str {
    #[cfg(windows)]
    {
        "Enter a full folder path, such as C:\\Documents\\Grapho."
    }
    #[cfg(not(windows))]
    {
        "Enter a full folder path, such as /home/you/Documents."
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Change {
    Write(Uuid),
    Remove(Uuid),
}

enum Job {
    Sync(Uuid),
    /// Copy the whole library, used when a connector is added.
    Seed(BackupLocation, oneshot::Sender<Result<(), BackupError>>),
    /// Answers after everything queued before it, for shutdown and tests.
    Barrier(oneshot::Sender<()>),
}

/// The connectors and the worker that keeps them up to date.
pub struct BackupMirror {
    store: SharedStore,
    connectors: RwLock<Vec<BackupLocation>>,
    /// Last failure per connector; `None` means the last copy worked.
    health: Mutex<HashMap<Uuid, Option<String>>>,
    jobs: mpsc::UnboundedSender<Job>,
    drive: std::sync::Arc<Drive>,
    secrets: std::sync::Arc<Secrets>,
}

impl BackupMirror {
    pub fn start(
        store: SharedStore,
        backups: Vec<BackupLocation>,
        drive: std::sync::Arc<Drive>,
        secrets: std::sync::Arc<Secrets>,
    ) -> std::sync::Arc<Self> {
        let (jobs, receiver) = mpsc::unbounded_channel();
        let mirror = std::sync::Arc::new(Self {
            store,
            connectors: RwLock::new(backups.clone()),
            health: Mutex::new(
                backups
                    .into_iter()
                    .map(|backup| (backup.id, None))
                    .collect(),
            ),
            jobs,
            drive,
            secrets,
        });

        tokio::spawn(run(mirror.clone(), receiver));
        mirror
    }

    /// Queue a document's current state. The request does not wait for copies.
    pub fn mirror_document(&self, id: Uuid) {
        let _ = self.jobs.send(Job::Sync(id));
    }

    pub async fn connectors(&self) -> Vec<BackupLocation> {
        self.connectors.read().await.clone()
    }

    pub async fn health(&self) -> HashMap<Uuid, Option<String>> {
        self.health.lock().expect("backup health lock").clone()
    }

    /// Wait until the copies queued so far are finished, or `wait` passes.
    /// Used at shutdown so the last save usually reaches the backups too.
    pub async fn flush(&self, wait: Duration) -> bool {
        let (reply, answer) = oneshot::channel();
        if self.jobs.send(Job::Barrier(reply)).is_err() {
            return false;
        }
        timeout(wait, answer).await.is_ok()
    }

    /// Validate a connector, copy the library into it, and start mirroring
    /// there.
    ///
    /// The caller supplies the id so credentials for a remote connector can be
    /// stored before the seed needs them. The copy runs on the worker, which is
    /// what makes adding a connector a single, honest action.
    pub async fn add(&self, location: BackupLocation) -> Result<BackupLocation, BackupError> {
        let target = normalize(location.target)?;
        let location = BackupLocation {
            id: location.id,
            target,
        };
        let data_dir = self.store.directory().await;

        match &location.target {
            BackupTarget::Folder { path } => {
                if store::same_directory(&data_dir, path) {
                    return Err(BackupError::SameAsDataFolder);
                }
                if path.starts_with(&data_dir) {
                    return Err(BackupError::InsideDataFolder);
                }
                if data_dir.starts_with(path) {
                    return Err(BackupError::ContainsDataFolder);
                }
                if self
                    .connectors
                    .read()
                    .await
                    .iter()
                    .any(|backup| match &backup.target {
                        BackupTarget::Folder { path: existing } => {
                            store::same_directory(existing, path)
                        }
                        _ => false,
                    })
                {
                    return Err(BackupError::AlreadyABackup);
                }
            }
            BackupTarget::Ssh {
                host,
                port,
                user,
                dir,
                key,
            } => {
                if self
                    .connectors
                    .read()
                    .await
                    .iter()
                    .any(|backup| same_ssh(&backup.target, host, *port, user, dir))
                {
                    return Err(BackupError::AlreadyABackup);
                }
                if let Some(key) = key {
                    if tokio::fs::metadata(key).await.is_err() {
                        return Err(BackupError::invalid(format!(
                            "The key file {} doesn't exist.",
                            key.display()
                        )));
                    }
                }
            }
            BackupTarget::GoogleDrive {
                client_id,
                folder_id,
                ..
            } => {
                if self
                    .connectors
                    .read()
                    .await
                    .iter()
                    .any(|backup| same_google(&backup.target, client_id, folder_id))
                {
                    return Err(BackupError::AlreadyABackup);
                }
            }
        }

        self.connectors.write().await.push(location.clone());
        self.health
            .lock()
            .expect("backup health lock")
            .insert(location.id, None);

        let (reply, answer) = oneshot::channel();
        if self.jobs.send(Job::Seed(location.clone(), reply)).is_err() {
            self.forget(&location.id).await;
            return Err(BackupError::Google {
                message: "the backup worker stopped".to_owned(),
            });
        }

        match answer.await {
            Ok(Ok(())) => Ok(location),
            Ok(Err(error)) => {
                self.forget(&location.id).await;
                Err(error)
            }
            Err(_) => {
                self.forget(&location.id).await;
                Err(BackupError::Google {
                    message: "the backup worker stopped".to_owned(),
                })
            }
        }
    }

    /// Stop mirroring into a connector. Files already copied stay where they
    /// are.
    pub async fn remove(&self, id: Uuid) -> bool {
        let mut connectors = self.connectors.write().await;
        let found = connectors.iter().any(|backup| backup.id == id);
        if found {
            connectors.retain(|backup| backup.id != id);
        }
        drop(connectors);

        if found {
            self.health.lock().expect("backup health lock").remove(&id);
        }
        found
    }

    async fn forget(&self, id: &Uuid) {
        self.connectors
            .write()
            .await
            .retain(|backup| backup.id != *id);
        self.health.lock().expect("backup health lock").remove(id);
    }

    async fn apply(&self, changes: &[Change]) {
        if changes.is_empty() {
            return;
        }

        for connector in self.connectors().await {
            let error = match &connector.target {
                BackupTarget::Folder { path } => self.apply_folder(path, changes).await,
                BackupTarget::Ssh { .. } => self.apply_ssh(&connector, changes).await,
                BackupTarget::GoogleDrive { .. } => self.apply_google(&connector, changes).await,
            };
            self.set_health(connector.id, error);
        }
    }

    async fn apply_folder(&self, folder: &Path, changes: &[Change]) -> Option<String> {
        let mut last_error = None;

        for change in changes {
            match change {
                Change::Write(id) => {
                    let Some(document) = self.store.get(*id).await else {
                        continue;
                    };
                    if let Err(error) = store::persist_document(folder, &document).await {
                        eprintln!("backup to {} failed: {error}", folder.display());
                        last_error = Some(error.to_string());
                    }
                }
                Change::Remove(id) => {
                    let path = folder.join(format!("{id}.json"));
                    match tokio::fs::remove_file(&path).await {
                        Ok(()) => {}
                        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                        Err(error) => {
                            eprintln!(
                                "could not remove {} from {}: {error}",
                                path.display(),
                                folder.display()
                            );
                            last_error =
                                Some(format!("could not remove a deleted document: {error}"));
                        }
                    }
                }
            }
        }

        last_error
    }

    async fn apply_ssh(&self, connector: &BackupLocation, changes: &[Change]) -> Option<String> {
        let target = SftpTarget::from_settings(&connector.target)?;
        let data_dir = self.store.directory().await;

        let mut script = sftp::mkdir(&target.dir);
        let mut operations = 0;
        for change in changes {
            match change {
                Change::Write(id) => {
                    let name = format!("{id}.json");
                    // A document deleted since the save has nothing to upload;
                    // its removal job follows in the queue.
                    if tokio::fs::metadata(data_dir.join(&name)).await.is_err() {
                        continue;
                    }
                    script.push_str(&sftp::upload(&name, &sftp::remote_path(&target.dir, *id)));
                    operations += 1;
                }
                Change::Remove(id) => {
                    script.push_str(&sftp::remove(&sftp::remote_path(&target.dir, *id)));
                    operations += 1;
                }
            }
        }

        if operations == 0 {
            return None;
        }

        match sftp::run(&target, &data_dir, &script).await {
            Ok(_) => None,
            Err(message) => {
                eprintln!("backup to {} failed: {message}", target.label());
                Some(message)
            }
        }
    }

    async fn apply_google(&self, connector: &BackupLocation, changes: &[Change]) -> Option<String> {
        let BackupTarget::GoogleDrive {
            client_id,
            folder_id,
            ..
        } = &connector.target
        else {
            return None;
        };

        let credentials = match self.google_credentials(connector.id, client_id) {
            Ok(credentials) => credentials,
            Err(message) => return Some(message),
        };

        let data_dir = self.store.directory().await;
        let drive = self.drive.clone();
        let connector_id = connector.id;
        let folder_id = folder_id.clone();
        let changes: Vec<(Uuid, bool)> = changes
            .iter()
            .map(|change| match change {
                Change::Write(id) => (*id, true),
                Change::Remove(id) => (*id, false),
            })
            .collect();

        let result = tokio::task::spawn_blocking(move || {
            sync_google(
                &drive,
                connector_id,
                &credentials,
                &folder_id,
                &data_dir,
                &changes,
            )
        })
        .await;

        match result {
            Ok(Ok(())) => None,
            Ok(Err(message)) => {
                eprintln!("backup to Google Drive failed: {message}");
                Some(message)
            }
            Err(error) => Some(format!("the Google Drive task stopped: {error}")),
        }
    }

    fn google_credentials(
        &self,
        connector_id: Uuid,
        client_id: &str,
    ) -> Result<Credentials, String> {
        let secret = self.secrets.get(connector_id).ok_or_else(|| {
            "The Google Drive sign-in is missing. Remove this backup and connect it again."
                .to_owned()
        })?;

        if secret.refresh_token.is_empty() {
            return Err(
                "The Google Drive sign-in is missing. Remove this backup and connect it again."
                    .to_owned(),
            );
        }

        Ok(Credentials {
            client_id: client_id.to_owned(),
            client_secret: secret.client_secret,
            refresh_token: secret.refresh_token,
        })
    }

    async fn seed(&self, location: &BackupLocation) -> Result<(), BackupError> {
        match &location.target {
            BackupTarget::Folder { path } => self.seed_folder(path).await,
            BackupTarget::Ssh { .. } => self.seed_ssh(location).await,
            BackupTarget::GoogleDrive { .. } => self.seed_google(location).await,
        }
    }

    async fn seed_folder(&self, folder: &Path) -> Result<(), BackupError> {
        tokio::fs::create_dir_all(folder)
            .await
            .map_err(|error| BackupError::io(folder, error))?;

        let known: HashSet<Uuid> = self
            .store
            .list()
            .await
            .into_iter()
            .map(|summary| summary.id)
            .collect();
        let existing = store::document_files(folder).await;
        let strangers = existing
            .iter()
            .filter(|(id, _)| !known.contains(id))
            .count();
        if strangers > 0 {
            return Err(BackupError::Occupied {
                documents: strangers,
            });
        }

        let existing_ids: HashSet<Uuid> = existing.iter().map(|(id, _)| *id).collect();
        let mut created = Vec::new();
        for summary in self.store.list().await {
            let Some(document) = self.store.get(summary.id).await else {
                continue;
            };
            if let Err(error) = store::persist_document(folder, &document).await {
                remove_files(folder, &created).await;
                return Err(BackupError::io(folder, error));
            }
            if !existing_ids.contains(&document.id) {
                created.push(document.id);
            }
        }

        Ok(())
    }

    async fn seed_ssh(&self, location: &BackupLocation) -> Result<(), BackupError> {
        let target =
            SftpTarget::from_settings(&location.target).ok_or_else(|| BackupError::Ssh {
                message: "that connector is not an SSH server".to_owned(),
            })?;
        let data_dir = self.store.directory().await;

        // One connection proves the host, the account, and the folder, and
        // catches a server that already holds another library.
        let listing = sftp::run(&target, &data_dir, &sftp::list(&target.dir))
            .await
            .map_err(|message| BackupError::Ssh { message })?;

        let known: HashSet<Uuid> = self
            .store
            .list()
            .await
            .into_iter()
            .map(|summary| summary.id)
            .collect();
        let strangers = sftp::parse_listing(&listing)
            .into_iter()
            .filter(|id| !known.contains(id))
            .count();
        if strangers > 0 {
            return Err(BackupError::Occupied {
                documents: strangers,
            });
        }

        let mut script = sftp::mkdir(&target.dir);
        for summary in self.store.list().await {
            let name = format!("{}.json", summary.id);
            if tokio::fs::metadata(data_dir.join(&name)).await.is_err() {
                continue;
            }
            script.push_str(&sftp::upload(
                &name,
                &sftp::remote_path(&target.dir, summary.id),
            ));
        }

        sftp::run(&target, &data_dir, &script)
            .await
            .map(|_| ())
            .map_err(|message| BackupError::Ssh { message })
    }

    async fn seed_google(&self, location: &BackupLocation) -> Result<(), BackupError> {
        let BackupTarget::GoogleDrive {
            client_id,
            folder_id,
            ..
        } = &location.target
        else {
            return Err(BackupError::Google {
                message: "that connector is not Google Drive".to_owned(),
            });
        };

        let credentials = self
            .google_credentials(location.id, client_id)
            .map_err(|message| BackupError::Google { message })?;

        let known: HashSet<Uuid> = self
            .store
            .list()
            .await
            .into_iter()
            .map(|summary| summary.id)
            .collect();
        let order: Vec<Uuid> = self
            .store
            .list()
            .await
            .into_iter()
            .map(|summary| summary.id)
            .collect();
        let data_dir = self.store.directory().await;
        let drive = self.drive.clone();
        let connector_id = location.id;
        let folder_id = folder_id.clone();

        let result = tokio::task::spawn_blocking(move || {
            seed_google_folder(
                &drive,
                connector_id,
                &credentials,
                &folder_id,
                &data_dir,
                &known,
                &order,
            )
        })
        .await;

        match result {
            Ok(Ok(())) => Ok(()),
            Ok(Err(SeedFailure::Occupied(documents))) => Err(BackupError::Occupied { documents }),
            Ok(Err(SeedFailure::Message(message))) => Err(BackupError::Google { message }),
            Err(error) => Err(BackupError::Google {
                message: format!("the Google Drive task stopped: {error}"),
            }),
        }
    }

    fn set_health(&self, id: Uuid, error: Option<String>) {
        self.health
            .lock()
            .expect("backup health lock")
            .insert(id, error);
    }
}

/// Why seeding a Drive folder failed. Occupied is kept separate so the page can
/// say "that folder already holds another library" instead of an API complaint.
enum SeedFailure {
    Occupied(usize),
    Message(String),
}

/// One batch of Drive copies. Runs on a blocking thread; the worker is the only
/// caller, so one list of the folder is enough for every change in the batch.
fn sync_google(
    drive: &Drive,
    connector_id: Uuid,
    credentials: &Credentials,
    folder_id: &str,
    data_dir: &Path,
    changes: &[(Uuid, bool)],
) -> Result<(), String> {
    let token = drive.access_token(connector_id, credentials)?;
    let remote = drive.list_folder(&token, folder_id)?;
    let mut by_name: HashMap<String, String> = remote
        .into_iter()
        .map(|file| (file.name, file.id))
        .collect();

    for (document, write) in changes {
        let name = format!("{document}.json");

        if *write {
            let bytes = std::fs::read(data_dir.join(&name))
                .map_err(|error| format!("could not read {name} for the backup: {error}"))?;
            let file_id = drive.upload(
                &token,
                by_name.get(&name).map(String::as_str),
                &name,
                folder_id,
                &bytes,
            )?;
            by_name.insert(name, file_id);
        } else if let Some(file_id) = by_name.remove(&name) {
            drive.delete(&token, &file_id)?;
        }
    }

    Ok(())
}

/// The first copy of a Drive connector: refuse another library's documents,
/// then upload every document in the library, updating files that are already
/// there under the same name.
fn seed_google_folder(
    drive: &Drive,
    connector_id: Uuid,
    credentials: &Credentials,
    folder_id: &str,
    data_dir: &Path,
    known: &HashSet<Uuid>,
    order: &[Uuid],
) -> Result<(), SeedFailure> {
    let token = drive
        .access_token(connector_id, credentials)
        .map_err(SeedFailure::Message)?;
    let remote = drive
        .list_folder(&token, folder_id)
        .map_err(SeedFailure::Message)?;

    let strangers = remote
        .iter()
        .filter_map(|file| store::document_file_id(Path::new(&file.name)))
        .filter(|document| !known.contains(document))
        .count();
    if strangers > 0 {
        return Err(SeedFailure::Occupied(strangers));
    }

    let mut by_name: HashMap<String, String> = remote
        .into_iter()
        .map(|file| (file.name, file.id))
        .collect();

    for document in order {
        let name = format!("{document}.json");
        let bytes = std::fs::read(data_dir.join(&name))
            .map_err(|error| SeedFailure::Message(format!("could not read {name}: {error}")))?;
        let file_id = drive
            .upload(
                &token,
                by_name.get(&name).map(String::as_str),
                &name,
                folder_id,
                &bytes,
            )
            .map_err(SeedFailure::Message)?;
        by_name.insert(name, file_id);
    }

    Ok(())
}

/// Trim and check the fields that would only fail much later otherwise.
fn normalize(target: BackupTarget) -> Result<BackupTarget, BackupError> {
    match target {
        BackupTarget::Folder { path } => {
            if !path.is_absolute() {
                return Err(BackupError::NotAbsolute);
            }
            Ok(BackupTarget::Folder { path })
        }
        BackupTarget::Ssh {
            host,
            port,
            user,
            dir,
            key,
        } => {
            let host = host.trim().to_owned();
            let user = user.trim().to_owned();
            let dir = sftp::normalized_remote_dir(dir.trim());

            let host_ok = !host.is_empty()
                && host.len() <= 255
                && !host.starts_with('-')
                && host.chars().all(|character| {
                    character.is_ascii_alphanumeric() || ".-_".contains(character)
                });
            if !host_ok {
                return Err(BackupError::invalid(
                    "Enter a server name or address, such as nas.local or 192.168.1.20.",
                ));
            }

            let user_ok = !user.is_empty()
                && user.len() <= 64
                && !user.starts_with('-')
                && user.chars().all(|character| {
                    character.is_ascii_alphanumeric() || ".-_".contains(character)
                });
            if !user_ok {
                return Err(BackupError::invalid(
                    "Enter the SSH user name, without spaces or symbols.",
                ));
            }

            if port == 0 {
                return Err(BackupError::invalid(
                    "Enter a port between 1 and 65535, or leave it empty for 22.",
                ));
            }

            let dir_ok = dir.starts_with('/')
                && !dir.contains('"')
                && !dir.contains('\n')
                && !dir.contains('\r')
                && dir.len() <= 4096;
            if !dir_ok {
                return Err(BackupError::invalid(
                    "Enter an absolute folder on the server, such as /volume1/grapho.",
                ));
            }

            if let Some(key) = &key {
                if !key.is_absolute() {
                    return Err(BackupError::invalid(
                        "Enter the full path to the key file, or leave it empty to use your SSH setup.",
                    ));
                }
            }

            Ok(BackupTarget::Ssh {
                host,
                port,
                user,
                dir,
                key,
            })
        }
        BackupTarget::GoogleDrive {
            client_id,
            folder,
            folder_id,
        } => {
            let client_id = client_id.trim().to_owned();
            let folder = folder.trim().to_owned();
            let folder_id = folder_id.trim().to_owned();

            if client_id.is_empty() || client_id.len() > 200 {
                return Err(BackupError::invalid(
                    "Paste the OAuth client id from your Google Cloud project.",
                ));
            }

            let folder_ok = !folder.is_empty()
                && folder.chars().count() <= 100
                && !folder.chars().any(char::is_control);
            if !folder_ok {
                return Err(BackupError::invalid(
                    "Give the Drive folder a name of up to 100 characters.",
                ));
            }

            if folder_id.is_empty() {
                return Err(BackupError::invalid(
                    "The Drive folder is missing; connect Google Drive again.",
                ));
            }

            Ok(BackupTarget::GoogleDrive {
                client_id,
                folder,
                folder_id,
            })
        }
    }
}

fn same_ssh(target: &BackupTarget, host: &str, port: u16, user: &str, dir: &str) -> bool {
    matches!(
        target,
        BackupTarget::Ssh {
            host: existing_host,
            port: existing_port,
            user: existing_user,
            dir: existing_dir,
            ..
        } if *existing_port == port
            && existing_user == user
            && existing_dir == dir
            && existing_host.eq_ignore_ascii_case(host)
    )
}

fn same_google(target: &BackupTarget, client_id: &str, folder_id: &str) -> bool {
    matches!(
        target,
        BackupTarget::GoogleDrive {
            client_id: existing_client,
            folder_id: existing_folder,
            ..
        } if existing_client == client_id && existing_folder == folder_id
    )
}

async fn remove_files(folder: &Path, ids: &[Uuid]) {
    for id in ids {
        let _ = tokio::fs::remove_file(folder.join(format!("{id}.json"))).await;
    }
}

async fn run(mirror: std::sync::Arc<BackupMirror>, mut jobs: mpsc::UnboundedReceiver<Job>) {
    while let Some(job) = jobs.recv().await {
        let mut batch = vec![job];
        while let Ok(next) = jobs.try_recv() {
            batch.push(next);
        }

        // Read the latest state once for each changed id. A restore can
        // finish before an earlier delete request has queued its mirror job.
        let mut order: Vec<Uuid> = Vec::new();
        let mut seen = HashSet::new();
        let mut barriers: Vec<oneshot::Sender<()>> = Vec::new();

        for job in batch {
            match job {
                Job::Sync(id) => {
                    if seen.insert(id) {
                        order.push(id);
                    }
                }
                Job::Seed(location, reply) => {
                    let result = mirror.seed(&location).await;
                    let _ = reply.send(result);
                }
                Job::Barrier(reply) => barriers.push(reply),
            }
        }

        let mut changes = Vec::with_capacity(order.len());
        for id in order {
            changes.push(if mirror.store.contains_active(id).await {
                Change::Write(id)
            } else {
                Change::Remove(id)
            });
        }

        mirror.apply(&changes).await;

        for reply in barriers {
            let _ = reply.send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drive::Drive;
    use crate::secrets::Secrets;
    use crate::store::Store;
    use std::sync::Arc;

    async fn test_mirror(label: &str) -> (Arc<BackupMirror>, PathBuf) {
        let directory =
            std::env::temp_dir().join(format!("grapho-backup-{label}-{}", Uuid::new_v4()));
        let store = Arc::new(Store::load(directory.clone()).await.expect("store loads"));
        let mirror = BackupMirror::start(
            store,
            Vec::new(),
            Arc::new(Drive::new()),
            Arc::new(Secrets::load(None)),
        );
        (mirror, directory)
    }

    fn folder(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("grapho-backup-dir-{label}-{}", Uuid::new_v4()))
    }

    async fn add(
        mirror: &BackupMirror,
        target: BackupTarget,
    ) -> Result<BackupLocation, BackupError> {
        mirror
            .add(BackupLocation {
                id: Uuid::new_v4(),
                target,
            })
            .await
    }

    async fn add_folder(
        mirror: &BackupMirror,
        path: PathBuf,
    ) -> Result<BackupLocation, BackupError> {
        add(mirror, BackupTarget::Folder { path }).await
    }

    async fn flush(mirror: &BackupMirror) {
        assert!(
            mirror.flush(std::time::Duration::from_secs(5)).await,
            "the worker answers"
        );
    }

    #[tokio::test]
    async fn adding_a_backup_copies_the_library_and_mirrors_later_saves() {
        let (mirror, directory) = test_mirror("copy").await;
        let store = mirror.store.clone();
        let document = store.create().await.expect("document is created");
        store
            .update(document.id, Some("First".to_owned()), None, None)
            .await
            .expect("update succeeds");

        let backup = folder("copy-target");
        add_folder(&mirror, backup.clone())
            .await
            .expect("the folder is added");

        let copied = tokio::fs::read_to_string(backup.join(format!("{}.json", document.id)))
            .await
            .expect("the document was copied");
        assert!(copied.contains("\"First\""));

        store
            .update(document.id, Some("Second".to_owned()), None, None)
            .await
            .expect("update succeeds");
        mirror.mirror_document(document.id);
        flush(&mirror).await;

        let mirrored = tokio::fs::read_to_string(backup.join(format!("{}.json", document.id)))
            .await
            .expect("the document was mirrored");
        assert!(mirrored.contains("\"Second\""));

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(backup).await;
    }

    #[tokio::test]
    async fn deleting_a_document_deletes_its_backup_copy() {
        let (mirror, directory) = test_mirror("delete").await;
        let store = mirror.store.clone();
        let document = store.create().await.expect("document is created");
        let backup = folder("delete-target");
        add_folder(&mirror, backup.clone())
            .await
            .expect("the folder is added");

        let copied = backup.join(format!("{}.json", document.id));
        assert!(copied.exists());

        store.delete(document.id).await.expect("delete succeeds");
        mirror.mirror_document(document.id);
        flush(&mirror).await;

        assert!(!copied.exists(), "the copy goes away with the document");

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(backup).await;
    }

    #[tokio::test]
    async fn a_missing_folder_fails_without_affecting_the_other_backups() {
        let (mirror, directory) = test_mirror("missing").await;
        let store = mirror.store.clone();
        let document = store.create().await.expect("document is created");

        let good = folder("missing-good");
        let missing = folder("missing-gone");
        add_folder(&mirror, good.clone())
            .await
            .expect("the folder is added");
        let broken = add_folder(&mirror, missing.clone())
            .await
            .expect("the folder is added");
        let broken_id = broken.id;

        tokio::fs::remove_dir_all(&missing)
            .await
            .expect("the drive is unplugged");

        store
            .update(document.id, Some("After unplug".to_owned()), None, None)
            .await
            .expect("update succeeds");
        mirror.mirror_document(document.id);
        flush(&mirror).await;

        let copied = tokio::fs::read_to_string(good.join(format!("{}.json", document.id)))
            .await
            .expect("the good folder still receives the document");
        assert!(copied.contains("After unplug"));

        let health = mirror.health().await;
        assert!(
            health[&broken_id].is_some(),
            "the failure was recorded for the folder that went away"
        );

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(good).await;
    }

    #[tokio::test]
    async fn a_folder_from_another_library_is_refused() {
        let (mirror, directory) = test_mirror("stranger").await;
        let target = folder("stranger-target");
        tokio::fs::create_dir_all(&target).await.unwrap();
        tokio::fs::write(target.join(format!("{}.json", Uuid::new_v4())), b"{}")
            .await
            .unwrap();

        match add_folder(&mirror, target.clone()).await {
            Err(BackupError::Occupied { documents }) => assert_eq!(documents, 1),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(mirror.connectors().await.is_empty());

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(target).await;
    }

    #[tokio::test]
    async fn the_data_folder_and_relative_paths_are_refused() {
        let (mirror, directory) = test_mirror("refuse").await;

        assert!(matches!(
            add_folder(&mirror, PathBuf::from("relative")).await,
            Err(BackupError::NotAbsolute)
        ));
        assert!(matches!(
            add_folder(&mirror, directory.clone()).await,
            Err(BackupError::SameAsDataFolder)
        ));
        assert!(matches!(
            add_folder(&mirror, directory.join("inside")).await,
            Err(BackupError::InsideDataFolder)
        ));
        assert!(matches!(
            add_folder(&mirror, directory.parent().unwrap().to_path_buf()).await,
            Err(BackupError::ContainsDataFolder)
        ));

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn the_newest_version_wins_when_saves_arrive_in_a_burst() {
        let (mirror, directory) = test_mirror("burst").await;
        let store = mirror.store.clone();
        let document = store.create().await.expect("document is created");
        let backup = folder("burst-target");
        add_folder(&mirror, backup.clone())
            .await
            .expect("the folder is added");
        let copied = backup.join(format!("{}.json", document.id));

        for title in ["One", "Two", "Three"] {
            store
                .update(document.id, Some(title.to_owned()), None, None)
                .await
                .expect("update succeeds");
            mirror.mirror_document(document.id);
        }
        flush(&mirror).await;

        let after = tokio::fs::read_to_string(&copied).await.unwrap();
        assert!(after.contains("\"Three\""), "the newest version wins");

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(backup).await;
    }

    fn ssh(host: &str, port: u16, user: &str, dir: &str, key: Option<PathBuf>) -> BackupTarget {
        BackupTarget::Ssh {
            host: host.to_owned(),
            port,
            user: user.to_owned(),
            dir: dir.to_owned(),
            key,
        }
    }

    #[tokio::test]
    async fn ssh_details_are_checked_before_a_connection_is_tried() {
        let (mirror, directory) = test_mirror("ssh-check").await;

        assert!(matches!(
            add(&mirror, ssh("", 22, "igor", "/grapho", None)).await,
            Err(BackupError::Invalid { .. })
        ));
        assert!(matches!(
            add(
                &mirror,
                ssh("-oProxyCommand=bad", 22, "igor", "/grapho", None)
            )
            .await,
            Err(BackupError::Invalid { .. })
        ));
        assert!(matches!(
            add(&mirror, ssh("nas.local", 22, "", "/grapho", None)).await,
            Err(BackupError::Invalid { .. })
        ));
        assert!(matches!(
            add(&mirror, ssh("nas.local", 0, "igor", "/grapho", None)).await,
            Err(BackupError::Invalid { .. })
        ));
        assert!(matches!(
            add(&mirror, ssh("nas.local", 22, "igor", "grapho", None)).await,
            Err(BackupError::Invalid { .. })
        ));
        assert!(matches!(
            add(
                &mirror,
                ssh(
                    "nas.local",
                    22,
                    "igor",
                    "/grapho",
                    Some(PathBuf::from("relative-key"))
                )
            )
            .await,
            Err(BackupError::Invalid { .. })
        ));
        assert!(matches!(
            add(
                &mirror,
                ssh(
                    "nas.local",
                    22,
                    "igor",
                    "/grapho",
                    Some(directory.join("missing-key"))
                )
            )
            .await,
            Err(BackupError::Invalid { .. })
        ));

        assert!(mirror.connectors().await.is_empty());

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn the_same_ssh_server_cannot_be_added_twice() {
        let (mirror, directory) = test_mirror("ssh-duplicate").await;
        let mirror = BackupMirror::start(
            mirror.store.clone(),
            vec![BackupLocation {
                id: Uuid::new_v4(),
                target: ssh("nas.local", 22, "igor", "/grapho", None),
            }],
            mirror.drive.clone(),
            mirror.secrets.clone(),
        );

        assert!(matches!(
            add(&mirror, ssh("NAS.local", 22, "igor", "/grapho/", None)).await,
            Err(BackupError::AlreadyABackup)
        ));

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    fn google(client_id: &str, folder: &str, folder_id: &str) -> BackupTarget {
        BackupTarget::GoogleDrive {
            client_id: client_id.to_owned(),
            folder: folder.to_owned(),
            folder_id: folder_id.to_owned(),
        }
    }

    #[tokio::test]
    async fn google_details_are_checked_before_any_request() {
        let (mirror, directory) = test_mirror("google-check").await;

        assert!(matches!(
            add(&mirror, google("", "Grapho", "folder-id")).await,
            Err(BackupError::Invalid { .. })
        ));
        assert!(matches!(
            add(&mirror, google("client", "", "folder-id")).await,
            Err(BackupError::Invalid { .. })
        ));
        assert!(matches!(
            add(&mirror, google("client", "Grapho", "")).await,
            Err(BackupError::Invalid { .. })
        ));
        assert!(matches!(
            add(&mirror, google("client", "a\nb", "folder-id")).await,
            Err(BackupError::Invalid { .. })
        ));

        assert!(mirror.connectors().await.is_empty());

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn the_same_google_folder_cannot_be_added_twice() {
        let (mirror, directory) = test_mirror("google-duplicate").await;
        let mirror = BackupMirror::start(
            mirror.store.clone(),
            vec![BackupLocation {
                id: Uuid::new_v4(),
                target: google("client", "Grapho", "folder-id"),
            }],
            mirror.drive.clone(),
            mirror.secrets.clone(),
        );

        assert!(matches!(
            add(&mirror, google("client", "Grapho", "folder-id")).await,
            Err(BackupError::AlreadyABackup)
        ));

        let _ = tokio::fs::remove_dir_all(directory).await;
    }
}
