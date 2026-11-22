//! The system SFTP client, driven in batch mode.
//!
//! Grapho does not link an SSH stack. It runs the OpenSSH `sftp` client that
//! desktop systems already ship, which keeps the binary small and reuses the
//! user's SSH configuration, agent, and known_hosts; no key material is stored
//! here. The cost is a dependency on that client, so SSH backups report plainly
//! when it is missing (the container image, for one, has no shell tools).
//!
//! One invocation carries a whole batch: `sftp -b -` reads commands from stdin,
//! so ten queued documents can be uploaded over one connection. Local paths
//! are bare file names because the process runs with a staging folder as its working
//! directory, which keeps spaces and Windows separators out of the command
//! parser.

use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::settings::BackupTarget;
use crate::store;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::timeout;

/// How long one sftp invocation may take before the copy is abandoned. The
/// client itself gives up on a connection attempt after ten seconds.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);

/// A validated SSH destination. `backup.rs` rejects bad values before building
/// one of these.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub host: String,
    pub port: u16,
    pub user: String,
    /// Absolute path as the SSH account sees it, without a trailing slash (the
    /// root stays `/`).
    pub dir: String,
    pub key: Option<PathBuf>,
}

impl Target {
    pub fn from_settings(target: &BackupTarget) -> Option<Self> {
        match target {
            BackupTarget::Ssh {
                host,
                port,
                user,
                dir,
                key,
            } => Some(Self {
                host: host.clone(),
                port: *port,
                user: user.clone(),
                dir: normalized_remote_dir(dir),
                key: key.clone(),
            }),
            BackupTarget::Folder { .. } => None,
            BackupTarget::GoogleDrive { .. } => None,
        }
    }

    /// How the connector is shown in the page and in logs.
    pub fn label(&self) -> String {
        if self.port == 22 {
            format!("{}@{}", self.user, self.host)
        } else {
            format!("{}@{}:{}", self.user, self.host, self.port)
        }
    }

    fn destination(&self) -> String {
        format!("{}@{}", self.user, self.host)
    }
}

pub fn normalized_remote_dir(dir: &str) -> String {
    let trimmed = dir.trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_owned()
    } else {
        trimmed.to_owned()
    }
}

pub fn remote_path(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// One batch command line. The remote side is quoted for sftp's parser; callers
/// have already rejected quotes and newlines in user-provided values.
fn quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\\\""))
}

pub fn mkdir(dir: &str) -> String {
    format!("-mkdir {}\n", quote(dir))
}

pub fn upload(local_name: &str, remote: &str) -> String {
    format!("put {} {}\n", quote(local_name), quote(remote))
}

pub fn download(remote: &str, local_name: &str) -> String {
    format!("get {} {}\n", quote(remote), quote(local_name))
}

pub fn remove(remote: &str) -> String {
    format!("rm {}\n", quote(remote))
}

pub fn list(dir: &str) -> String {
    format!("ls -1 {}\n", quote(dir))
}

/// Document names and the metadata index in an `ls -1` listing. The batch echo lines and anything else
/// the client prints are ignored.
pub fn parse_listing(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        // OpenSSH lists absolute paths or bare names. Ignore command output
        // such as "Removing /backups/<id>.md" that ends in a document name.
        .filter(|line| line.starts_with('/') || !line.contains('/'))
        .filter_map(|line| line.rsplit('/').next())
        .filter(|name| *name == store::INDEX_FILE || store::managed_file_id(name).is_some())
        .map(str::to_owned)
        .collect()
}

/// Run one batch, from `working_directory`, and return what
/// the client printed. File names in the script are relative to it.
pub async fn run(
    target: &Target,
    working_directory: &Path,
    script: &str,
) -> Result<String, String> {
    let mut command = Command::new("sftp");
    command
        .current_dir(working_directory)
        .arg("-q")
        .arg("-b")
        .arg("-")
        // No prompts: a background copy must never wait for a person.
        .arg("-o")
        .arg("BatchMode=yes")
        // Trust a host on first use, refuse it if its key later changes.
        .arg("-o")
        .arg("StrictHostKeyChecking=accept-new")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg("-P")
        .arg(target.port.to_string());

    if let Some(key) = &target.key {
        command.arg("-i").arg(key);
    }

    command.arg(target.destination());
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => {
            "Grapho couldn't find the sftp command. SSH backups need OpenSSH's sftp client installed, or use a folder instead."
                .to_owned()
        }
        _ => format!("Grapho couldn't start sftp: {error}"),
    })?;

    // Read the client's output while the script is still being written: a long
    // seed would otherwise fill the output pipe and stall us mid-write.
    let stdout = child.stdout.take().expect("sftp stdout is piped");
    let stderr = child.stderr.take().expect("sftp stderr is piped");
    let stdout_reader = tokio::spawn(read_all(stdout));
    let stderr_reader = tokio::spawn(read_all(stderr));

    if let Some(mut input) = child.stdin.take() {
        if let Err(error) = input.write_all(script.as_bytes()).await {
            let _ = child.kill().await;
            return Err(format!("Grapho couldn't send the batch to sftp: {error}"));
        }
        // A batch ends when stdin closes, which happens as this handle drops.
    }

    let status = match timeout(NETWORK_TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => return Err(format!("Grapho lost track of sftp: {error}")),
        Err(_) => {
            let _ = child.kill().await;
            return Err("The SSH server did not answer within 30 seconds.".to_owned());
        }
    };

    let stdout = stdout_reader.await.unwrap_or_default();
    let stderr = stderr_reader.await.unwrap_or_default();

    if status.success() {
        Ok(stdout)
    } else {
        Err(last_message(&stderr, &stdout, status.code()))
    }
}

async fn read_all(mut stream: impl AsyncRead + Unpin) -> String {
    let mut bytes = Vec::new();
    let _ = stream.read_to_end(&mut bytes).await;
    String::from_utf8_lossy(&bytes).into_owned()
}

/// The most specific complaint the client made, for the storage page.
fn last_message(stderr: &str, stdout: &str, code: Option<i32>) -> String {
    let line = stderr
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .or_else(|| {
            stdout
                .lines()
                .rev()
                .map(str::trim)
                .find(|line| !line.is_empty())
        });

    match line {
        Some(line) => line.to_owned(),
        None => format!("sftp exited with status {}", code.unwrap_or(-1)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commands_quote_the_remote_side() {
        assert_eq!(mkdir("/backups/grapho"), "-mkdir \"/backups/grapho\"\n");
        assert_eq!(
            upload(
                "6f9c1f2e-0000-4000-8000-000000000000.md",
                "/backups/a b/x.json"
            ),
            "put \"6f9c1f2e-0000-4000-8000-000000000000.md\" \"/backups/a b/x.json\"\n"
        );
        assert_eq!(
            remove("/backups/grapho/x.json"),
            "rm \"/backups/grapho/x.json\"\n"
        );
        assert_eq!(list("/backups"), "ls -1 \"/backups\"\n");
    }

    #[test]
    fn the_remote_folder_is_normalized_and_joined() {
        assert_eq!(normalized_remote_dir("/backups/grapho/"), "/backups/grapho");
        assert_eq!(normalized_remote_dir("/"), "/");
        assert_eq!(normalized_remote_dir("///"), "/");

        let name = "6f9c1f2e-0000-4000-8000-000000000000.md";
        assert_eq!(
            remote_path("/backups/grapho", name),
            "/backups/grapho/6f9c1f2e-0000-4000-8000-000000000000.md"
        );
        assert_eq!(
            remote_path("/", name),
            "/6f9c1f2e-0000-4000-8000-000000000000.md"
        );
    }

    #[test]
    fn listings_yield_only_document_names() {
        let output = concat!(
            "Removing /backups/grapho/2f9c1f2e-0000-4000-8000-000000000000.md\n",
            "sftp> -ls -1 \"/backups/grapho\"\n",
            "/backups/grapho/6f9c1f2e-0000-4000-8000-000000000000.md\n",
            "/backups/grapho/notes.txt\n",
            "/backups/grapho/.hidden.json\n",
            "\n"
        );

        let ids = parse_listing(output);
        assert_eq!(ids.len(), 1);
        assert_eq!(ids[0], "6f9c1f2e-0000-4000-8000-000000000000.md");
    }

    #[test]
    fn a_connector_is_labelled_with_its_port_only_when_needed() {
        let target = Target {
            host: "nas.local".to_owned(),
            port: 22,
            user: "igor".to_owned(),
            dir: "/grapho".to_owned(),
            key: None,
        };
        assert_eq!(target.label(), "igor@nas.local");

        let other = Target {
            port: 2222,
            ..target
        };
        assert_eq!(other.label(), "igor@nas.local:2222");
    }
}
