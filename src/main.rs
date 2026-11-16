mod api;
mod assets;
mod auth;
mod store;

use std::env;
use std::error::Error;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::net::TcpListener;

use crate::auth::Auth;
use crate::store::Store;

type BoxError = Box<dyn Error + Send + Sync>;

// The port spells "BLANK" on a phone keypad and is unassigned, so it is
// unlikely to collide with a local development server.
const DEFAULT_ADDR: &str = "127.0.0.1:25265";

const USAGE: &str = "\
  grapho                start the server
  grapho hash-password  print an Argon2id hash for GRAPHO_PASSWORD_HASH
  grapho --help         show this message
  grapho --version      print the version

  Configuration comes from GRAPHO_ADDR, GRAPHO_DATA_DIR, and
  GRAPHO_PASSWORD_HASH (or GRAPHO_PASSWORD_HASH_FILE). See the README.
";

#[tokio::main]
async fn main() {
    let command = match command_from_args(env::args().skip(1)) {
        Ok(command) => command,
        Err(message) => {
            eprintln!("\n  {message}\n");
            eprint!("{USAGE}");
            std::process::exit(2);
        }
    };

    match command {
        Command::Serve => {
            if let Err(error) = run().await {
                eprintln!("\n  grapho couldn't start");
                eprintln!("  {error}\n");
                std::process::exit(1);
            }
        }
        Command::HashPassword => {
            if let Err(message) = auth::print_password_hash() {
                eprintln!("\n  grapho hash-password: {message}\n");
                std::process::exit(1);
            }
        }
        Command::Help => print!("{USAGE}"),
        Command::Version => println!("grapho {}", env!("CARGO_PKG_VERSION")),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Command {
    Serve,
    HashPassword,
    Help,
    Version,
}

fn command_from_args(mut args: impl Iterator<Item = String>) -> Result<Command, String> {
    let Some(first) = args.next() else {
        return Ok(Command::Serve);
    };

    let command = match first.as_str() {
        "hash-password" => Command::HashPassword,
        "-h" | "--help" => Command::Help,
        "-V" | "--version" => Command::Version,
        other => return Err(format!("unrecognised command {other:?}")),
    };

    if let Some(extra) = args.next() {
        return Err(format!("unrecognised argument after {first}: {extra:?}"));
    }

    Ok(command)
}

async fn run() -> Result<(), BoxError> {
    let config = Config::from_env()?;
    let store = Arc::new(Store::load(config.data_dir.clone()).await?);
    let has_password = config.auth.is_some();
    let app = api::router(store, config.auth.map(Arc::new));

    let listener = TcpListener::bind(config.address)
        .await
        .map_err(|error| format!("could not listen on {}: {error}", config.address))?;
    let address = listener.local_addr()?;

    print_banner(address, &config.data_dir, has_password);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    println!("\n  Grapho stopped. Your words are on disk.\n");
    Ok(())
}

struct Config {
    address: SocketAddr,
    data_dir: PathBuf,
    auth: Option<Auth>,
}

impl Config {
    fn from_env() -> Result<Self, BoxError> {
        let raw_address = env::var("GRAPHO_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_owned());
        let address = raw_address.parse::<SocketAddr>().map_err(|error| {
            format!("GRAPHO_ADDR is not a valid socket address ({raw_address:?}): {error}")
        })?;

        let data_dir = data_dir_from_environment()?;

        let auth = Auth::from_environment()?;

        Ok(Self {
            address,
            data_dir,
            auth,
        })
    }
}

/// Where documents live when nothing else decides it. Installed builds are
/// launched from arbitrary working directories by service managers, shims, and
/// shortcuts, so they cannot rely on a relative path.
// Every variant exists on every platform so the rules below stay testable
// wherever the suite runs, even though only one is constructed in a build.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Platform {
    Unix,
    MacOs,
    Windows,
}

fn current_platform() -> Platform {
    #[cfg(windows)]
    const PLATFORM: Platform = Platform::Windows;
    #[cfg(target_os = "macos")]
    const PLATFORM: Platform = Platform::MacOs;
    #[cfg(all(unix, not(target_os = "macos")))]
    const PLATFORM: Platform = Platform::Unix;

    PLATFORM
}

fn data_dir_from_environment() -> Result<PathBuf, BoxError> {
    if let Some(configured) = env::var_os("GRAPHO_DATA_DIR") {
        return absolute(PathBuf::from(configured));
    }

    if let Some(portable) = portable_data_dir() {
        return Ok(portable);
    }

    let home = env::var_os("HOME").map(PathBuf::from);
    let xdg_data_home = env::var_os("XDG_DATA_HOME").map(PathBuf::from);
    let local_app_data = env::var_os("LOCALAPPDATA").map(PathBuf::from);

    let directory = per_user_data_dir(
        current_platform(),
        home.as_deref(),
        xdg_data_home.as_deref(),
        local_app_data.as_deref(),
    )
    .unwrap_or_else(|| PathBuf::from("data"));

    absolute(directory)
}

fn per_user_data_dir(
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
fn portable_data_dir() -> Option<PathBuf> {
    let candidate = env::current_dir().ok()?.join("data");
    directory_holds_documents(&candidate).then_some(candidate)
}

fn directory_holds_documents(directory: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return false;
    };

    entries.flatten().any(|entry| {
        entry
            .path()
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
    })
}

fn absolute(path: PathBuf) -> Result<PathBuf, BoxError> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(env::current_dir()?.join(path))
    }
}

fn print_banner(address: SocketAddr, data_dir: &Path, has_password: bool) {
    let url = local_url(address);
    println!();
    println!("  grapho");
    println!("  a quiet place to write");
    println!();
    println!("  Local    {url}");
    println!("  Data     {}", data_dir.display());
    println!(
        "  Login    {}",
        if has_password {
            "password required"
        } else {
            "off"
        }
    );
    println!("  Stop     Ctrl+C");
    println!();

    if !address.ip().is_loopback() {
        if has_password {
            println!("  Network access is on. The password protects the documents, but traffic");
            println!("  is not encrypted: serve Grapho through HTTPS or a VPN.");
        } else {
            println!("  Network access is on with no password. Anyone who can reach this port can");
            println!("  read and change your documents. Set GRAPHO_PASSWORD_HASH (`grapho");
            println!("  hash-password`), or keep Grapho behind a VPN or an authenticating proxy.");
        }
        println!();
    }
}

fn local_url(address: SocketAddr) -> String {
    if address.ip().is_unspecified() {
        let loopback = match address.ip() {
            IpAddr::V4(_) => IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            IpAddr::V6(_) => IpAddr::V6(std::net::Ipv6Addr::LOCALHOST),
        };
        let display = SocketAddr::new(loopback, address.port());
        format!("http://{display}")
    } else if address.is_ipv6() {
        format!("http://[{}]:{}", address.ip(), address.port())
    } else {
        format!("http://{address}")
    }
}

/// Wait for Ctrl+C, or for SIGTERM when a service manager or container stops us.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        let mut terminate = match signal(SignalKind::terminate()) {
            Ok(signal) => signal,
            Err(error) => {
                eprintln!("could not listen for SIGTERM: {error}");
                wait_for_ctrl_c().await;
                return;
            }
        };

        tokio::select! {
            _ = wait_for_ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    wait_for_ctrl_c().await;
}

async fn wait_for_ctrl_c() {
    if let Err(error) = tokio::signal::ctrl_c().await {
        eprintln!("could not listen for Ctrl+C: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_address_is_valid() {
        assert!(DEFAULT_ADDR.parse::<SocketAddr>().is_ok());
    }

    #[test]
    fn local_url_is_readable_for_wildcard_binds() {
        assert_eq!(
            local_url("0.0.0.0:25265".parse().unwrap()),
            "http://127.0.0.1:25265"
        );
        assert_eq!(
            local_url("[::]:25265".parse().unwrap()),
            "http://[::1]:25265"
        );
        assert_eq!(
            local_url("127.0.0.1:4000".parse().unwrap()),
            "http://127.0.0.1:4000"
        );
    }

    #[test]
    fn commands_are_recognised() {
        let parse =
            |args: &[&str]| command_from_args(args.iter().map(|argument| (*argument).to_owned()));

        assert_eq!(parse(&[]), Ok(Command::Serve));
        assert_eq!(parse(&["hash-password"]), Ok(Command::HashPassword));
        assert_eq!(parse(&["--help"]), Ok(Command::Help));
        assert_eq!(parse(&["-h"]), Ok(Command::Help));
        assert_eq!(parse(&["--version"]), Ok(Command::Version));

        assert!(parse(&["--password", "hunter2"]).is_err());
        assert!(parse(&["hash-password", "extra"]).is_err());
    }

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
    fn only_a_folder_with_json_documents_is_a_portable_store() {
        let root = env::temp_dir().join(format!("grapho-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        assert!(!directory_holds_documents(&root));

        std::fs::write(root.join("README.md"), b"not a document").unwrap();
        assert!(!directory_holds_documents(&root));

        std::fs::write(
            root.join("6f9c1f2e-0000-4000-8000-000000000000.json"),
            b"{}",
        )
        .unwrap();
        assert!(directory_holds_documents(&root));

        std::fs::remove_dir_all(&root).unwrap();
    }
}
