mod api;
mod assets;
mod store;

use std::env;
use std::error::Error;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use tokio::net::TcpListener;

use crate::store::Store;

type BoxError = Box<dyn Error + Send + Sync>;

// The port spells "BLANK" on a phone keypad and is unassigned, so it is
// unlikely to collide with a local development server.
const DEFAULT_ADDR: &str = "127.0.0.1:25265";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("\n  grapho couldn't start");
        eprintln!("  {error}\n");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), BoxError> {
    let config = Config::from_env()?;
    let store = Arc::new(Store::load(config.data_dir.clone()).await?);
    let app = api::router(store);

    let listener = TcpListener::bind(config.address)
        .await
        .map_err(|error| format!("could not listen on {}: {error}", config.address))?;
    let address = listener.local_addr()?;

    print_banner(address, &config.data_dir);

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    println!("\n  Grapho stopped. Your words are on disk.\n");
    Ok(())
}

struct Config {
    address: SocketAddr,
    data_dir: PathBuf,
}

impl Config {
    fn from_env() -> Result<Self, BoxError> {
        let raw_address = env::var("GRAPHO_ADDR").unwrap_or_else(|_| DEFAULT_ADDR.to_owned());
        let address = raw_address.parse::<SocketAddr>().map_err(|error| {
            format!("GRAPHO_ADDR is not a valid socket address ({raw_address:?}): {error}")
        })?;

        let data_dir = env::var_os("GRAPHO_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("data"));
        let data_dir = if data_dir.is_absolute() {
            data_dir
        } else {
            env::current_dir()?.join(data_dir)
        };

        Ok(Self { address, data_dir })
    }
}

fn print_banner(address: SocketAddr, data_dir: &std::path::Path) {
    let url = local_url(address);
    println!();
    println!("  grapho");
    println!("  a quiet place to write");
    println!();
    println!("  Local    {url}");
    println!("  Data     {}", data_dir.display());
    println!("  Stop     Ctrl+C");
    println!();

    if !address.ip().is_loopback() {
        println!("  Network access is on. Grapho has no built-in login, so keep it on");
        println!("  your home network or place it behind an authenticating reverse proxy.");
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

async fn shutdown_signal() {
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
}
