//! Where Grapho keeps its files.
//!
//! Two locations matter: the data directory that holds documents and their
//! metadata index, and a settings file that remembers the folder chosen in the
//! browser and the backup connectors that mirror it. The settings file lives
//! outside the data directory so that moving the documents cannot lose the
//! record of where they went.

use std::env;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::store::{document_file_id, replace_file};

/// Which rule picked the data directory, so the storage page can explain it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Environment,
    Settings,
    Portable,
    Default,
}

/// Everything Grapho remembers between runs. The file stays small and
/// human-readable: a folder, and the backup connectors that mirror it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_dir: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub backups: Vec<BackupLocation>,
}

/// One backup connector.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct BackupLocation {
    pub id: Uuid,
    #[serde(flatten)]
    pub target: BackupTarget,
}

/// Where a backup goes. A folder entry written before connectors had a kind is
/// still readable: `read` fills in the kind from the shape of the entry.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum BackupTarget {
    Folder {
        path: PathBuf,
    },
    Ssh {
        host: String,
        #[serde(default = "default_port")]
        port: u16,
        user: String,
        /// Absolute path on the server, as the SSH account sees it.
        dir: String,
        /// Optional private key file; without one the SSH client uses its own
        /// configuration and agent.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key: Option<PathBuf>,
    },
    #[serde(rename = "googledrive")]
    GoogleDrive {
        /// The OAuth client the user created in their own Google Cloud project.
        client_id: String,
        /// The Drive folder's name, so the page can show where the copies go.
        folder: String,
        /// The folder's Drive id, found or created when the connector was set up.
        folder_id: String,
    },
}

fn default_port() -> u16 {
    22
}

/// Every variant exists on every platform so the rules below stay testable
/// wherever the suite runs, even though only one is constructed in a build.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Unix,
    MacOs,
    Windows,
}

pub fn current_platform() -> Platform {
    #[cfg(windows)]
    const PLATFORM: Platform = Platform::Windows;
    #[cfg(target_os = "macos")]
    const PLATFORM: Platform = Platform::MacOs;
    #[cfg(all(unix, not(target_os = "macos")))]
    const PLATFORM: Platform = Platform::Unix;

    PLATFORM
}

/// Where documents live when nothing else decides it. Installed builds are
/// launched from arbitrary working directories by service managers, shims, and
/// shortcuts, so they cannot rely on a relative path.
pub fn per_user_data_dir(
    platform: Platform,
    home: Option<&Path>,
    xdg_data_home: Option<&Path>,
    local_app_data: Option<&Path>,
) -> Option<PathBuf> {
    match platform {
        Platform::Unix => {
            // The XDG base directory specification ignores relative values.
            let base = xdg_data_home
                .filter(|path| path.is_absolute())
                .map(Path::to_path_buf)
                .or_else(|| home.map(|home| home.join(".local").join("share")))?;
            Some(base.join("grapho"))
        }
        Platform::MacOs => Some(
            home?
                .join("Library")
                .join("Application Support")
                .join("Grapho"),
        ),
        Platform::Windows => {
            let base = local_app_data
                .map(Path::to_path_buf)
                .or_else(|| home.map(|home| home.join("AppData").join("Local")))?;
            Some(base.join("Grapho"))
        }
    }
}

/// `./data` stays in use while it already holds documents, so a checkout or a
/// folder copied around still behaves the way it did before the per-user
/// default existed.
pub fn portable_data_dir() -> Option<PathBuf> {
    let candidate = env::current_dir().ok()?.join("data");
    directory_holds_documents(&candidate).then_some(candidate)
}

pub fn directory_holds_documents(directory: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return false;
    };

    entries.flatten().any(|entry| {
        entry.file_type().is_ok_and(|kind| kind.is_file())
            && document_file_id(&entry.path()).is_some()
    })
}

/// The per-user settings file. It sits beside the other files the platform
/// keeps for an application, never inside the data directory it describes:
/// `%APPDATA%\Grapho\config.json` on Windows,
/// `~/Library/Preferences/Grapho/config.json` on macOS, and
/// `$XDG_CONFIG_HOME/grapho/config.json` (usually `~/.config/grapho`) elsewhere.
pub fn config_path(
    platform: Platform,
    home: Option<&Path>,
    xdg_config_home: Option<&Path>,
    app_data: Option<&Path>,
) -> Option<PathBuf> {
    match platform {
        Platform::Unix => {
            let base = xdg_config_home
                .filter(|path| path.is_absolute())
                .map(Path::to_path_buf)
                .or_else(|| home.map(|home| home.join(".config")))?;
            Some(base.join("grapho").join("config.json"))
        }
        Platform::MacOs => Some(
            home?
                .join("Library")
                .join("Preferences")
                .join("Grapho")
                .join("config.json"),
        ),
        Platform::Windows => {
            let base = app_data
                .map(Path::to_path_buf)
                .or_else(|| home.map(|home| home.join("AppData").join("Roaming")))?;
            Some(base.join("Grapho").join("config.json"))
        }
    }
}

/// The settings file for this user, or `None` when the environment does not say
/// where a per-user configuration belongs.
pub fn path() -> Option<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from);
    let xdg_config_home = env::var_os("XDG_CONFIG_HOME").map(PathBuf::from);
    let app_data = env::var_os("APPDATA").map(PathBuf::from);

    config_path(
        current_platform(),
        home.as_deref(),
        xdg_config_home.as_deref(),
        app_data.as_deref(),
    )
}

/// The settings for this user. A missing, unreadable, or malformed file simply
/// means "nothing saved yet": the folder rules elsewhere still produce a usable
/// directory, and there are no backup connectors.
pub fn load() -> Settings {
    path().map(|file| read(&file)).unwrap_or_default()
}

/// Read a settings file. Values that could only misbehave are dropped rather
/// than trusted: an empty data folder, a relative backup path, a connector
/// missing its host.
pub fn read(file: &Path) -> Settings {
    let Ok(bytes) = std::fs::read(file) else {
        return Settings::default();
    };
    // A file saved by a Windows editor may carry a UTF-8 byte order mark.
    let bytes = strip_bom(&bytes);
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Settings::default();
    };

    let data_dir = value
        .get("data_dir")
        .and_then(|value| value.as_str())
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);

    let backups = value
        .get("backups")
        .and_then(|value| value.as_array())
        .map(|entries| entries.iter().filter_map(backup_from_json).collect())
        .unwrap_or_default();

    Settings { data_dir, backups }
}

/// JSON readers reject a leading byte order mark, which some Windows editors
/// write. Treat it as the encoding detail it is.
fn strip_bom(bytes: &[u8]) -> &[u8] {
    bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes)
}

fn backup_from_json(value: &serde_json::Value) -> Option<BackupLocation> {
    let id = value.get("id")?.as_str()?.parse::<Uuid>().ok()?;

    let target = if value.get("kind").is_some() {
        serde_json::from_value::<BackupTarget>(value.clone()).ok()?
    } else {
        // Files written before connectors had a kind: the entry was a folder.
        let path = PathBuf::from(value.get("path")?.as_str()?);
        BackupTarget::Folder { path }
    };

    usable(&target).then_some(BackupLocation { id, target })
}

/// The cheap sanity checks that keep a hand-edited file from producing a
/// connector that can never work. `backup.rs` does the rest when it is added.
fn usable(target: &BackupTarget) -> bool {
    match target {
        BackupTarget::Folder { path } => path.is_absolute(),
        BackupTarget::Ssh {
            host,
            port,
            user,
            dir,
            key,
        } => {
            !host.trim().is_empty()
                && !user.trim().is_empty()
                && dir.starts_with('/')
                && *port > 0
                && key.as_ref().is_none_or(|path| path.is_absolute())
        }
        BackupTarget::GoogleDrive {
            client_id,
            folder,
            folder_id,
        } => {
            !client_id.trim().is_empty()
                && !folder.trim().is_empty()
                && !folder_id.trim().is_empty()
        }
    }
}

/// Write the settings. The file is replaced through a temporary file so a crash
/// cannot leave half a settings file behind.
pub async fn write(file: &Path, settings: &Settings) -> io::Result<()> {
    write_json(file, settings).await
}

/// Atomically write a JSON file in the configuration directory.
pub(crate) async fn write_json(file: &Path, value: &impl Serialize) -> io::Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).await?;
    }

    let bytes = serde_json::to_vec_pretty(value)?;
    let temporary = file.with_extension("json.tmp");

    let mut handle = fs::File::create(&temporary).await?;
    handle.write_all(&bytes).await?;
    handle.sync_all().await?;
    drop(handle);

    replace_file(&temporary, file).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_user_data_dir_follows_each_platform() {
        // Temp paths are absolute on every platform, so this test can check the
        // macOS and Windows branches everywhere.
        let base = env::temp_dir();
        let home = base.join("home");
        let xdg = base.join("xdg");
        let local_app_data = base.join("local");
        let relative = Path::new("relative");

        assert_eq!(
            per_user_data_dir(Platform::Unix, Some(&home), Some(&xdg), None),
            Some(xdg.join("grapho"))
        );
        assert_eq!(
            per_user_data_dir(Platform::Unix, Some(&home), None, None),
            Some(home.join(".local").join("share").join("grapho"))
        );
        assert_eq!(
            per_user_data_dir(Platform::Unix, Some(&home), Some(relative), None),
            Some(home.join(".local").join("share").join("grapho")),
            "a relative XDG_DATA_HOME is ignored"
        );
        assert_eq!(per_user_data_dir(Platform::Unix, None, None, None), None);

        assert_eq!(
            per_user_data_dir(Platform::MacOs, Some(&home), None, None),
            Some(
                home.join("Library")
                    .join("Application Support")
                    .join("Grapho")
            )
        );
        assert_eq!(per_user_data_dir(Platform::MacOs, None, None, None), None);

        assert_eq!(
            per_user_data_dir(Platform::Windows, Some(&home), None, Some(&local_app_data)),
            Some(local_app_data.join("Grapho"))
        );
        assert_eq!(
            per_user_data_dir(Platform::Windows, Some(&home), None, None),
            Some(home.join("AppData").join("Local").join("Grapho")),
            "LOCALAPPDATA is preferred but not required"
        );
        assert_eq!(per_user_data_dir(Platform::Windows, None, None, None), None);
    }

    #[test]
    fn the_settings_file_sits_outside_the_data_directory() {
        let base = env::temp_dir();
        let home = base.join("home");
        let xdg = base.join("xdg");
        let app_data = base.join("roaming");
        let relative = Path::new("relative");

        assert_eq!(
            config_path(Platform::Unix, Some(&home), Some(&xdg), None),
            Some(xdg.join("grapho").join("config.json"))
        );
        assert_eq!(
            config_path(Platform::Unix, Some(&home), None, None),
            Some(home.join(".config").join("grapho").join("config.json"))
        );
        assert_eq!(
            config_path(Platform::Unix, Some(&home), Some(relative), None),
            Some(home.join(".config").join("grapho").join("config.json")),
            "a relative XDG_CONFIG_HOME is ignored"
        );
        assert_eq!(config_path(Platform::Unix, None, None, None), None);

        assert_eq!(
            config_path(Platform::MacOs, Some(&home), None, None),
            Some(
                home.join("Library")
                    .join("Preferences")
                    .join("Grapho")
                    .join("config.json")
            )
        );

        assert_eq!(
            config_path(Platform::Windows, Some(&home), None, Some(&app_data)),
            Some(app_data.join("Grapho").join("config.json"))
        );
        assert_eq!(
            config_path(Platform::Windows, Some(&home), None, None),
            Some(
                home.join("AppData")
                    .join("Roaming")
                    .join("Grapho")
                    .join("config.json")
            )
        );
        assert_eq!(config_path(Platform::Windows, None, None, None), None);

        // The macOS settings file must not share a folder with the documents.
        assert_ne!(
            config_path(Platform::MacOs, Some(&home), None, None),
            per_user_data_dir(Platform::MacOs, Some(&home), None, None)
                .map(|dir| dir.join("config.json"))
        );
    }

    #[test]
    fn only_a_folder_with_markdown_documents_is_a_portable_store() {
        let root = env::temp_dir().join(format!("grapho-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        assert!(!directory_holds_documents(&root));

        std::fs::write(root.join("README.md"), b"not a document").unwrap();
        std::fs::write(root.join("metadata.json"), b"{}").unwrap();
        std::fs::write(
            root.join("6f9c1f2e-0000-4000-8000-000000000000.json"),
            b"{}",
        )
        .unwrap();
        assert!(!directory_holds_documents(&root));

        std::fs::write(root.join("6f9c1f2e-0000-4000-8000-000000000000.md"), b"{}").unwrap();
        assert!(directory_holds_documents(&root));

        std::fs::remove_dir_all(&root).unwrap();
    }

    #[tokio::test]
    async fn settings_round_trip_and_drop_unusable_values() {
        let root = env::temp_dir().join(format!("grapho-settings-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("config.json");

        assert_eq!(
            read(&file),
            Settings::default(),
            "a missing file has no settings"
        );

        let chosen = root.join("documents");
        let folder = BackupLocation {
            id: Uuid::new_v4(),
            target: BackupTarget::Folder {
                path: root.join("backup"),
            },
        };
        let ssh = BackupLocation {
            id: Uuid::new_v4(),
            target: BackupTarget::Ssh {
                host: "nas.local".to_owned(),
                port: 2222,
                user: "igor".to_owned(),
                dir: "/volume1/grapho".to_owned(),
                key: Some(root.join("id_ed25519")),
            },
        };
        let settings = Settings {
            data_dir: Some(chosen.clone()),
            backups: vec![folder.clone(), ssh.clone()],
        };
        write(&file, &settings).await.unwrap();

        let loaded = read(&file);
        assert_eq!(loaded.data_dir, Some(chosen));
        assert_eq!(loaded.backups, vec![folder, ssh]);

        std::fs::write(&file, b"{ not json").unwrap();
        assert_eq!(read(&file), Settings::default(), "a broken file is ignored");

        std::fs::write(
            &file,
            br#"{"data_dir": "", "backups": [{"id": "6f9c1f2e-0000-4000-8000-000000000000", "path": "relative"}]}"#,
        )
        .unwrap();
        let cleaned = read(&file);
        assert_eq!(cleaned.data_dir, None, "an empty folder is ignored");
        assert!(
            cleaned.backups.is_empty(),
            "a relative backup folder is ignored"
        );

        std::fs::write(
            &file,
            br#"{"backups": [{"kind": "ssh", "id": "6f9c1f2e-0000-4000-8000-000000000000", "host": "nas", "user": "igor", "dir": "relative-dir"}]}"#,
        )
        .unwrap();
        assert!(
            read(&file).backups.is_empty(),
            "an SSH connector without an absolute remote folder is ignored"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_folder_backup_written_before_kinds_still_loads() {
        let root = env::temp_dir().join(format!("grapho-settings-legacy-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("config.json");

        let id = Uuid::new_v4();
        let path = root.join("backup");
        let legacy = serde_json::json!({ "backups": [{ "id": id, "path": path }] });
        std::fs::write(&file, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let loaded = read(&file);
        assert_eq!(
            loaded.backups,
            vec![BackupLocation {
                id,
                target: BackupTarget::Folder { path },
            }]
        );

        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_settings_file_with_a_byte_order_mark_still_loads() {
        let root = env::temp_dir().join(format!("grapho-settings-bom-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("config.json");

        let id = Uuid::new_v4();
        let path = root.join("backup");
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(
            serde_json::to_string(&serde_json::json!({
                "backups": [{ "id": id, "check": "value", "path": path }]
            }))
            .unwrap()
            .as_bytes(),
        );
        std::fs::write(&file, bytes).unwrap();

        let loaded = read(&file);
        assert_eq!(loaded.backups.len(), 1, "the BOM is not a parse error");

        let _ = std::fs::remove_dir_all(root);
    }
}
