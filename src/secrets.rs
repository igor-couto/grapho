//! Connector secrets.
//!
//! The settings file is meant to be read and edited by a person, so it holds no
//! credentials. The Google Drive connector needs two: the OAuth client secret and
//! the refresh token. They live in their own file beside the settings file, with
//! owner-only permissions where the platform has them.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::store::replace_file;

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Secret {
    #[serde(default)]
    pub client_secret: String,
    #[serde(default)]
    pub refresh_token: String,
}

/// The secrets for every connector that has them, kept in memory and written
/// through as they change.
pub struct Secrets {
    file: Option<PathBuf>,
    values: Mutex<HashMap<Uuid, Secret>>,
}

impl Secrets {
    /// Load the secrets file. A missing or malformed file simply means no
    /// connector is signed in yet; the connectors that need secrets report it.
    pub fn load(file: Option<PathBuf>) -> Self {
        let values = file
            .as_deref()
            .and_then(|file| std::fs::read(file).ok())
            .and_then(|bytes| {
                // Some Windows editors add a byte order mark to JSON files.
                let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(&bytes);
                serde_json::from_slice::<HashMap<Uuid, Secret>>(bytes).ok()
            })
            .unwrap_or_default();

        Self {
            file,
            values: Mutex::new(values),
        }
    }

    /// Whether there is anywhere to keep a secret. Without a configuration
    /// directory the Google Drive connector cannot remember its sign-in.
    pub fn available(&self) -> bool {
        self.file.is_some()
    }

    pub fn get(&self, id: Uuid) -> Option<Secret> {
        self.values.lock().expect("secrets lock").get(&id).cloned()
    }

    pub async fn set(&self, id: Uuid, secret: Secret) -> io::Result<()> {
        let snapshot = {
            let mut values = self.values.lock().expect("secrets lock");
            values.insert(id, secret);
            values.clone()
        };
        self.write(&snapshot).await
    }

    pub async fn remove(&self, id: Uuid) -> io::Result<()> {
        let snapshot = {
            let mut values = self.values.lock().expect("secrets lock");
            values.remove(&id);
            values.clone()
        };
        self.write(&snapshot).await
    }

    async fn write(&self, values: &HashMap<Uuid, Secret>) -> io::Result<()> {
        let Some(file) = &self.file else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "this system has no configuration folder for secrets",
            ));
        };

        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).await?;
        }

        let bytes = serde_json::to_vec_pretty(values).expect("secrets are always serialisable");
        let temporary = file.with_extension("json.tmp");

        let mut handle = fs::File::create(&temporary).await?;
        handle.write_all(&bytes).await?;
        handle.sync_all().await?;
        drop(handle);

        // Owner-only before the file takes its real name.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o600)).await?;
        }

        replace_file(&temporary, file).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn secrets_round_trip_and_are_forgotten() {
        let root = std::env::temp_dir().join(format!("grapho-secrets-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("secrets.json");
        let store = Secrets::load(Some(file.clone()));

        assert!(!store.available() || store.get(Uuid::nil()).is_none());

        let id = Uuid::new_v4();
        store
            .set(
                id,
                Secret {
                    client_secret: "client-secret".to_owned(),
                    refresh_token: "refresh-token".to_owned(),
                },
            )
            .await
            .expect("the secret is written");

        let reloaded = Secrets::load(Some(file.clone()));
        assert_eq!(
            reloaded.get(id).expect("the secret is there").refresh_token,
            "refresh-token"
        );

        store.remove(id).await.expect("the secret is removed");
        assert!(Secrets::load(Some(file)).get(id).is_none());

        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_secrets_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("grapho-secrets-mode-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("secrets.json");
        let store = Secrets::load(Some(file.clone()));
        store
            .set(
                Uuid::new_v4(),
                Secret {
                    client_secret: "s".to_owned(),
                    refresh_token: "r".to_owned(),
                },
            )
            .await
            .unwrap();

        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        let _ = std::fs::remove_dir_all(root);
    }
}
