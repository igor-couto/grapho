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
use crate::store::{self, BackupSnapshot, SharedStore};

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

async fn folder_key(path: &Path) -> Result<PathBuf, BackupError> {
    store::directory_key(path)
        .await
        .map_err(|error| BackupError::io(path, error))
}

fn separate_folders(data: &Path, backup: &Path) -> Result<(), BackupError> {
    if data == backup {
        Err(BackupError::SameAsDataFolder)
    } else if backup.starts_with(data) {
        Err(BackupError::InsideDataFolder)
    } else if data.starts_with(backup) {
        Err(BackupError::ContainsDataFolder)
    } else {
        Ok(())
    }
}

enum Job {
    Sync(Uuid),
    SyncImport(Vec<Uuid>),
    Forget(Uuid),
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
        retry_file: Option<PathBuf>,
    ) -> std::sync::Arc<Self> {
        let (jobs, receiver) = mpsc::unbounded_channel();
        let mut retries: HashMap<Uuid, HashSet<Uuid>> = retry_file
            .as_deref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        retries.retain(|id, ids| !ids.is_empty() && backups.iter().any(|backup| backup.id == *id));
        let mirror = std::sync::Arc::new(Self {
            store,
            connectors: RwLock::new(backups.clone()),
            health: Mutex::new(
                backups
                    .into_iter()
                    .map(|backup| {
                        let error = retries.contains_key(&backup.id).then(|| {
                            "Waiting to retry changes from a previous session.".to_owned()
                        });
                        (backup.id, error)
                    })
                    .collect(),
            ),
            jobs,
            drive,
            secrets,
        });

        tokio::spawn(run(mirror.clone(), receiver, retry_file, retries));
        mirror
    }

    /// Queue a document's current state. The request does not wait for copies.
    pub fn mirror_document(&self, id: Uuid) {
        let _ = self.jobs.send(Job::Sync(id));
    }

    pub fn mirror_space(&self, imported: Vec<Uuid>) {
        if imported.is_empty() {
            // The Space changed the index alone.
            self.mirror_document(Uuid::nil());
        } else {
            // Write all imported bodies before publishing their index entries.
            let _ = self.jobs.send(Job::SyncImport(imported));
        }
    }

    pub async fn connectors(&self) -> Vec<BackupLocation> {
        self.connectors.read().await.clone()
    }

    pub async fn validate_data_folder(&self, path: &Path) -> Result<(), BackupError> {
        if !path.is_absolute() {
            return Err(BackupError::NotAbsolute);
        }
        let data = folder_key(path).await?;
        for connector in self.connectors().await {
            if let BackupTarget::Folder { path: backup } = connector.target {
                // A disconnected drive can be impossible to resolve. Its saved
                // path can still be checked, and the worker checks its actual
                // destination again before touching any document.
                let separation = match folder_key(&backup).await {
                    Ok(key) => separate_folders(&data, &key),
                    Err(_) => separate_folders(path, &backup),
                };
                if separation.is_err() {
                    return Err(BackupError::invalid(
                        "Choose a data folder separate from every backup folder.",
                    ));
                }
            }
        }
        Ok(())
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
        match &location.target {
            BackupTarget::Folder { path } => {
                let backup = folder_key(path).await?;
                self.validate_backup_folder(&backup).await?;
                for connector in self.connectors().await {
                    if let BackupTarget::Folder { path: existing } = connector.target {
                        if existing == *path
                            || folder_key(&existing).await.is_ok_and(|key| key == backup)
                        {
                            return Err(BackupError::AlreadyABackup);
                        }
                    }
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
            let _ = self.jobs.send(Job::Forget(id));
        }
        found
    }

    async fn forget(&self, id: &Uuid) {
        self.connectors
            .write()
            .await
            .retain(|backup| backup.id != *id);
        self.health.lock().expect("backup health lock").remove(id);
        let _ = self.jobs.send(Job::Forget(*id));
    }

    async fn apply(&self, ids: &HashSet<Uuid>, retries: &mut HashMap<Uuid, HashSet<Uuid>>) -> bool {
        let mut updated = false;
        for connector in self.connectors().await {
            // Adding reserves the destination before seeding checks it. A
            // queued save must wait until the seed has accepted the folder.
            if !self
                .health
                .lock()
                .expect("backup health lock")
                .contains_key(&connector.id)
            {
                continue;
            }
            // A failed batch is retried from the current committed state.
            let mut batch = ids.clone();
            if let Some(missed) = retries.get(&connector.id) {
                batch.extend(missed);
            }
            let result = self.sync(&connector, Some(&batch)).await;
            if result.is_err() {
                if retries.get(&connector.id) != Some(&batch) {
                    retries.insert(connector.id, batch);
                    updated = true;
                }
            } else {
                updated |= retries.remove(&connector.id).is_some();
            }
            let error = result.err().map(|error| {
                eprintln!("backup failed: {error}");
                error.to_string()
            });
            self.set_health(connector.id, error);
        }
        updated
    }

    async fn sync(
        &self,
        location: &BackupLocation,
        ids: Option<&HashSet<Uuid>>,
    ) -> Result<(), BackupError> {
        let seed = ids.is_none();
        let data = self.store.directory().await;
        let snapshot = self
            .store
            .backup_snapshot(ids)
            .await
            .map_err(|error| BackupError::io(&data, error))?;
        if !seed && !snapshot.index_changed && snapshot.changed.is_empty() {
            return Ok(());
        }
        match &location.target {
            BackupTarget::Folder { path } => {
                // Finish in-flight writes before removing a connector and
                // allowing its target to become the primary data folder.
                let connectors = self.connectors.read().await;
                if !connectors
                    .iter()
                    .any(|connector| connector.id == location.id)
                {
                    return Ok(());
                }
                self.validate_backup_folder(&folder_key(path).await?)
                    .await?;
                sync_folder(path, &snapshot, seed).await
            }
            BackupTarget::Ssh { .. } => {
                let target = SftpTarget::from_settings(&location.target).expect("SSH connector");
                sync_ssh(&target, snapshot, seed).await
            }
            BackupTarget::GoogleDrive {
                client_id,
                folder_id,
                ..
            } => {
                let credentials = self
                    .google_credentials(location.id, client_id)
                    .map_err(|message| BackupError::Google { message })?;
                let drive = self.drive.clone();
                let id = location.id;
                let folder_id = folder_id.clone();
                let result = tokio::task::spawn_blocking(move || {
                    sync_google(&drive, id, &credentials, &folder_id, &snapshot, seed)
                })
                .await;
                result.map_err(|error| BackupError::Google {
                    message: format!("the Google Drive task stopped: {error}"),
                })?
            }
        }
    }

    async fn seed(&self, location: &BackupLocation) -> Result<(), BackupError> {
        self.sync(location, None).await
    }

    async fn validate_backup_folder(&self, backup: &Path) -> Result<(), BackupError> {
        for directory in self.store.directories().await {
            separate_folders(&folder_key(&directory).await?, backup)?;
        }
        Ok(())
    }

    fn google_credentials(
        &self,
        connector_id: Uuid,
        client_id: &str,
    ) -> Result<Credentials, String> {
        let missing = || {
            "The Google Drive sign-in is missing. Remove this backup and connect it again."
                .to_owned()
        };
        let secret = self.secrets.get(connector_id).ok_or_else(missing)?;
        if secret.refresh_token.is_empty() {
            return Err(missing());
        }
        Ok(Credentials {
            client_id: client_id.to_owned(),
            client_secret: secret.client_secret,
            refresh_token: secret.refresh_token,
        })
    }

    fn set_health(&self, id: Uuid, error: Option<String>) {
        if let Some(health) = self.health.lock().expect("backup health lock").get_mut(&id) {
            *health = error;
        }
    }
}

/// Seeding can refresh copies from this library, but never merge libraries.
fn check_foreign_files<'a>(
    names: impl IntoIterator<Item = &'a str>,
    known: &HashSet<Uuid>,
) -> Result<(), BackupError> {
    let documents = names
        .into_iter()
        .filter_map(|name| {
            let path = Path::new(name);
            (path.file_name()?.to_str()? == name)
                .then(|| store::mirror_document_id(path))
                .flatten()
        })
        .filter(|id| !known.contains(id))
        .count();
    if documents > 0 {
        return Err(BackupError::Occupied { documents });
    }
    Ok(())
}

fn check_backup_index(bytes: &[u8]) -> Result<(), BackupError> {
    if !store::is_backup_index(bytes) {
        return Err(BackupError::invalid(
            "That folder already holds a metadata.json file that is not a Grapho backup. Choose another folder.",
        ));
    }
    Ok(())
}

async fn sync_folder(
    folder: &Path,
    snapshot: &BackupSnapshot,
    seed: bool,
) -> Result<(), BackupError> {
    if seed {
        tokio::fs::create_dir_all(folder)
            .await
            .map_err(|error| BackupError::io(folder, error))?;
    }
    let index = folder.join(store::INDEX_FILE);
    match tokio::fs::read(&index).await {
        Ok(bytes) => check_backup_index(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(BackupError::io(&index, error)),
    }
    let mut entries = tokio::fs::read_dir(folder)
        .await
        .map_err(|error| BackupError::io(folder, error))?;
    let mut names = Vec::new();
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| BackupError::io(folder, error))?
    {
        if entry
            .file_type()
            .await
            .map_err(|error| BackupError::io(folder, error))?
            .is_file()
        {
            if let Ok(name) = entry.file_name().into_string() {
                names.push(name);
            }
        }
    }
    if seed {
        check_foreign_files(names.iter().map(String::as_str), &snapshot.known)?;
    }

    for (name, bytes) in &snapshot.files {
        store::write_data_file(&folder.join(name), bytes)
            .await
            .map_err(|error| BackupError::io(folder, error))?;
    }
    for name in names.iter().filter(|name| snapshot.obsolete(name)) {
        tokio::fs::remove_file(folder.join(name))
            .await
            .map_err(|error| BackupError::io(folder, error))?;
    }
    store::write_data_file(&folder.join(store::INDEX_FILE), &snapshot.index)
        .await
        .map_err(|error| BackupError::io(folder, error))
}

async fn sync_ssh(
    target: &SftpTarget,
    snapshot: BackupSnapshot,
    seed: bool,
) -> Result<(), BackupError> {
    let folder = std::env::temp_dir().join(format!("grapho-sftp-{}", Uuid::new_v4()));
    let ssh_error = |message| BackupError::Ssh { message };
    tokio::fs::create_dir(&folder)
        .await
        .map_err(|error| BackupError::io(&folder, error))?;
    let result = async {
        let list = sftp::list(&target.dir);
        let index_path = sftp::remote_path(&target.dir, store::INDEX_FILE);
        let download = sftp::download(&index_path, store::INDEX_FILE);
        // An empty destination has no index yet. If the listing shows one,
        // require the download to succeed before writing anything.
        let inspect = format!("{}{list}-{download}", if seed { "-" } else { "" });
        let listing = sftp::run(target, &folder, &inspect)
            .await
            .map_err(|message| {
                eprintln!("backup to {} failed: {message}", target.label());
                ssh_error(message)
            })?;
        let names = sftp::parse_listing(&listing);
        if seed {
            check_foreign_files(names.iter().map(String::as_str), &snapshot.known)?;
        }
        if names.iter().any(|name| name == store::INDEX_FILE) {
            let index = folder.join(store::INDEX_FILE);
            let bytes = tokio::fs::read(&index)
                .await
                .map_err(|error| BackupError::io(&index, error))?;
            check_backup_index(&bytes)?;
        }
        let mut script = sftp::mkdir(&target.dir);
        for (name, bytes) in &snapshot.files {
            tokio::fs::write(folder.join(name), bytes)
                .await
                .map_err(|error| BackupError::io(&folder, error))?;
            script.push_str(&sftp::upload(name, &sftp::remote_path(&target.dir, name)));
        }
        for name in names.iter().filter(|name| snapshot.obsolete(name)) {
            script.push_str(&sftp::remove(&sftp::remote_path(&target.dir, name)));
        }
        tokio::fs::write(folder.join(store::INDEX_FILE), &snapshot.index)
            .await
            .map_err(|error| BackupError::io(&folder, error))?;
        script.push_str(&sftp::upload(
            store::INDEX_FILE,
            &sftp::remote_path(&target.dir, store::INDEX_FILE),
        ));
        sftp::run(target, &folder, &script)
            .await
            .map_err(ssh_error)?;
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_dir_all(folder).await;
    result
}

/// The worker is the only caller, so each batch needs a single Drive listing.
fn sync_google(
    drive: &Drive,
    connector_id: Uuid,
    credentials: &Credentials,
    folder_id: &str,
    snapshot: &BackupSnapshot,
    seed: bool,
) -> Result<(), BackupError> {
    let google_error = |message| BackupError::Google { message };
    let token = drive
        .access_token(connector_id, credentials)
        .map_err(google_error)?;
    let remote = drive.list_folder(&token, folder_id).map_err(google_error)?;
    if seed {
        check_foreign_files(
            remote.iter().map(|file| file.name.as_str()),
            &snapshot.known,
        )?;
    }
    let by_name: HashMap<_, _> = remote
        .iter()
        .map(|file| (file.name.as_str(), file.id.as_str()))
        .collect();
    if let Some(index_id) = by_name.get(store::INDEX_FILE) {
        let index = drive
            .download_text(&token, index_id)
            .map_err(google_error)?;
        check_backup_index(index.as_bytes())?;
    }
    for (name, bytes) in &snapshot.files {
        drive
            .upload(
                &token,
                by_name.get(name.as_str()).copied(),
                name,
                folder_id,
                bytes,
            )
            .map_err(google_error)?;
    }
    for file in remote.iter().filter(|file| snapshot.obsolete(&file.name)) {
        drive.delete(&token, &file.id).map_err(google_error)?;
    }
    drive
        .upload(
            &token,
            by_name.get(store::INDEX_FILE).copied(),
            store::INDEX_FILE,
            folder_id,
            &snapshot.index,
        )
        .map_err(google_error)?;
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

async fn run(
    mirror: std::sync::Arc<BackupMirror>,
    mut jobs: mpsc::UnboundedReceiver<Job>,
    retry_file: Option<PathBuf>,
    mut retries: HashMap<Uuid, HashSet<Uuid>>,
) {
    let mut retries_changed = false;
    while let Some(job) = jobs.recv().await {
        let mut batch = vec![job];
        while let Ok(next) = jobs.try_recv() {
            batch.push(next);
        }

        let mut seen = HashSet::new();
        let mut barriers: Vec<oneshot::Sender<()>> = Vec::new();

        for job in batch {
            match job {
                Job::Sync(id) => {
                    seen.insert(id);
                }
                Job::SyncImport(imported) => seen.extend(imported),
                Job::Forget(id) => {
                    retries_changed |= retries.remove(&id).is_some();
                }
                Job::Seed(location, reply) => {
                    let result = mirror.seed(&location).await;
                    if result.is_ok() {
                        mirror
                            .health
                            .lock()
                            .expect("backup health lock")
                            .insert(location.id, None);
                    }
                    let _ = reply.send(result);
                }
                Job::Barrier(reply) => barriers.push(reply),
            }
        }

        if !seen.is_empty() {
            retries_changed |= mirror.apply(&seen, &mut retries).await;
        }
        if let Some(file) = retry_file.as_ref().filter(|_| retries_changed) {
            if let Err(error) = crate::settings::write_json(file, &retries).await {
                eprintln!("could not remember pending backup retries: {error}");
            } else {
                retries_changed = false;
            }
        }

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
            None,
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
            .update(
                document.id,
                Some("First".to_owned()),
                Some("<p>Body</p>".to_owned()),
                None,
            )
            .await
            .expect("update succeeds");

        let backup = folder("copy-target");
        add_folder(&mirror, backup.clone())
            .await
            .expect("the folder is added");

        let copied = tokio::fs::read_to_string(backup.join(format!("{}.md", document.id)))
            .await
            .expect("the document was copied");
        assert_eq!(copied, "Body\n");
        let index = tokio::fs::read_to_string(backup.join(store::INDEX_FILE))
            .await
            .unwrap();
        assert!(index.contains("\"First\""));

        store
            .update(document.id, Some("Second".to_owned()), None, None)
            .await
            .expect("update succeeds");
        mirror.mirror_document(document.id);
        flush(&mirror).await;

        let mirrored = tokio::fs::read_to_string(backup.join(store::INDEX_FILE))
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
        let content = "<img alt=\"Picture\" src=\"data:image/png;base64,AA==\">";
        store
            .update(document.id, None, Some(content.into()), None)
            .await
            .unwrap();
        let backup = folder("delete-target");
        add_folder(&mirror, backup.clone())
            .await
            .expect("the folder is added");

        let copied = backup.join(format!("{}.md", document.id));
        assert!(copied.exists());
        let body = tokio::fs::read_to_string(&copied).await.unwrap();
        let image_name = body
            .trim()
            .strip_prefix("![Picture](")
            .unwrap()
            .strip_suffix(')')
            .unwrap();
        let image = backup.join(image_name);
        assert!(image.is_file());

        store.delete(document.id).await.expect("delete succeeds");
        mirror.mirror_document(document.id);
        flush(&mirror).await;

        assert!(!copied.exists(), "the copy goes away with the document");
        assert!(!image.exists());
        assert!(Store::load(backup.clone())
            .await
            .unwrap()
            .list()
            .await
            .is_empty());

        store.restore(document.id).await.unwrap();
        mirror.mirror_document(document.id);
        flush(&mirror).await;
        assert!(image.is_file());
        let restored = Store::load(backup.clone())
            .await
            .unwrap()
            .get(document.id)
            .await
            .unwrap();
        assert_eq!(restored.content, content);

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

        let copied = tokio::fs::read_to_string(good.join(store::INDEX_FILE))
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
        let foreign = Store::load(target.clone()).await.unwrap();
        let note = foreign.create().await.unwrap();
        let index_path = target.join(store::INDEX_FILE);
        let index = tokio::fs::read(&index_path).await.unwrap();

        match add_folder(&mirror, target.clone()).await {
            Err(BackupError::Invalid { message }) => assert!(message.contains("metadata.json")),
            other => panic!("expected a refusal, got {other:?}"),
        }
        assert!(mirror.connectors().await.is_empty());
        assert_eq!(tokio::fs::read(index_path).await.unwrap(), index);
        let restored = Store::load(target.clone()).await.unwrap();
        assert!(restored.get(note.id).await.is_some());

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(target).await;
    }

    #[tokio::test]
    async fn regression_reconnected_backup_catches_up_on_the_next_save() {
        let (mirror, directory) = test_mirror("reconnect").await;
        let note = mirror.store.create().await.unwrap();
        let target = folder("reconnect");
        let connector = add_folder(&mirror, target.clone()).await.unwrap();
        let offline = target.with_extension("offline");
        tokio::fs::rename(&target, &offline).await.unwrap();

        mirror
            .store
            .update(note.id, Some("Written offline".into()), None, None)
            .await
            .unwrap();
        mirror.mirror_document(note.id);
        flush(&mirror).await;
        assert!(mirror.health().await[&connector.id].is_some());

        tokio::fs::rename(&offline, &target).await.unwrap();
        let other = mirror.store.create().await.unwrap();
        mirror.mirror_document(other.id);
        flush(&mirror).await;
        assert!(target.join(format!("{}.md", other.id)).is_file());
        let error = mirror.health().await[&connector.id].clone();
        let copy = Store::load(target.clone())
            .await
            .unwrap()
            .get(note.id)
            .await
            .unwrap();
        tokio::fs::remove_dir_all(directory).await.unwrap();
        tokio::fs::remove_dir_all(target).await.unwrap();
        assert!(
            error.is_none(),
            "the connector is healthy after catching up"
        );
        assert_eq!(
            copy.title, "Written offline",
            "connector error after reconnect: {error:?}"
        );
    }

    #[tokio::test]
    async fn a_missed_deletion_is_retried_after_restart() {
        let directory = folder("restart-primary");
        let target = folder("restart-drive");
        let retry_dir = folder("restart-config");
        let retry_file = retry_dir.join("backup-retries.json");
        let start = |store, connectors| {
            BackupMirror::start(
                store,
                connectors,
                Arc::new(Drive::new()),
                Arc::new(Secrets::load(None)),
                Some(retry_file.clone()),
            )
        };
        let mirror = start(
            Arc::new(Store::load(directory.clone()).await.unwrap()),
            vec![],
        );
        let document = mirror.store.create().await.unwrap();
        let connector = add_folder(&mirror, target.clone()).await.unwrap();
        let copied = target.join(format!("{}.md", document.id));
        assert!(copied.exists());
        assert!(!retry_file.exists());

        let offline = target.with_extension("offline");
        tokio::fs::rename(&target, &offline).await.unwrap();
        mirror.store.delete(document.id).await.unwrap();
        mirror.mirror_document(document.id);
        flush(&mirror).await;
        assert!(mirror.health().await[&connector.id].is_some());
        drop(mirror);

        let restarted = start(
            Arc::new(Store::load(directory.clone()).await.unwrap()),
            vec![connector.clone()],
        );
        assert!(restarted.health().await[&connector.id].is_some());
        tokio::fs::rename(&offline, &target).await.unwrap();
        let other = restarted.store.create().await.unwrap();
        restarted.mirror_document(other.id);
        flush(&restarted).await;
        assert!(!copied.exists());
        assert!(target.join(format!("{}.md", other.id)).exists());
        assert!(restarted.health().await[&connector.id].is_none());
        let saved = std::fs::read(retry_file).unwrap();
        let pending: HashMap<Uuid, HashSet<Uuid>> = serde_json::from_slice(&saved).unwrap();
        assert!(pending.is_empty());
        for path in [directory, target, retry_dir] {
            tokio::fs::remove_dir_all(path).await.unwrap();
        }
    }

    #[tokio::test]
    async fn a_remembered_backup_pointing_at_the_library_never_removes_a_document() {
        let directory = folder("remembered-overlap");
        let store = Arc::new(Store::load(directory.clone()).await.unwrap());
        let child = directory.join("child");
        tokio::fs::create_dir(&child).await.unwrap();
        let connector = BackupLocation {
            id: Uuid::new_v4(),
            target: BackupTarget::Folder {
                path: child.join(".."),
            },
        };
        let mirror = BackupMirror::start(
            store.clone(),
            vec![connector.clone()],
            Arc::new(Drive::new()),
            Arc::new(Secrets::load(None)),
            None,
        );
        let note = store.create().await.unwrap();
        store.delete(note.id).await.unwrap();
        mirror.mirror_document(note.id);
        flush(&mirror).await;
        assert!(mirror.health().await[&connector.id].is_some());
        let reopened = Store::load(directory.clone()).await.unwrap();
        assert!(reopened.restore(note.id).await.unwrap().is_some());
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_new_folder_beneath_a_symlink_to_the_library_is_refused() {
        let (mirror, directory) = test_mirror("symlink").await;
        let alias = folder("symlink-target");
        std::os::unix::fs::symlink(&directory, &alias).unwrap();
        let child = alias.join("new");
        assert!(matches!(
            add_folder(&mirror, child.clone()).await,
            Err(BackupError::InsideDataFolder)
        ));
        assert!(!child.exists());
        tokio::fs::remove_file(alias).await.unwrap();
        tokio::fs::remove_dir_all(directory).await.unwrap();
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
        let copied = backup.join(store::INDEX_FILE);

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
            None,
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
            None,
        );

        assert!(matches!(
            add(&mirror, google("client", "Grapho", "folder-id")).await,
            Err(BackupError::AlreadyABackup)
        ));

        let _ = tokio::fs::remove_dir_all(directory).await;
    }
}
