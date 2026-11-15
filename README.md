# Grapho

Grapho is a small writing app that runs in the browser. It is one Rust binary with
no database, account system, or frontend build step. Documents are plain JSON
files on disk.

The home screen lists and searches documents. The editor has the formatting I use
most, holds images, saves as you type, and can export to HTML, Markdown, or plain
text. Light and dark themes are included.

## Running

Requires Rust 1.89 or newer. On Windows, that means the MSVC toolchain with the
C++ build tools, or a GNU toolchain with MinGW-w64 on `PATH`.

```bash
git clone https://github.com/igor-couto/grapho.git
cd grapho
cargo run --release
```

Open http://127.0.0.1:3000. The first run creates a `data/` directory in the
project root. The compiled binary is `target/release/grapho` (`grapho.exe` on
Windows); it can be copied elsewhere and run on its own.

Useful shortcuts: `Ctrl+S` saves now, `Ctrl+K` adds a link, `Ctrl+B` / `Ctrl+I` /
`Ctrl+U` format text, and `/` focuses the search box on the home screen.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `GRAPHO_ADDR` | `127.0.0.1:3000` | Address and port to listen on. |
| `GRAPHO_DATA_DIR` | `data` | Directory for document JSON files. |

For example, to use Grapho from other devices on your network:

```bash
GRAPHO_ADDR=0.0.0.0:3000 cargo run --release
```

On PowerShell, run `$env:GRAPHO_ADDR = "0.0.0.0:3000"` first.

There is no built-in login or TLS. Keep it on a trusted network, or put a VPN or
an authenticating reverse proxy in front of it. If you use a proxy, preserve the
`Host` header.

## Data

Documents are stored in `GRAPHO_DATA_DIR/<document-id>.json` (under `data/` by
default). Each file contains the title, sanitized HTML, and timestamps. Images are
embedded as base64 data URLs, so a document stays one self-contained file; photos
are shrunk in the browser first. A save replaces the file through a temporary
file, so a crash is unlikely to leave a half-written document.

Copy the whole directory to back it up. Stop Grapho first if you want a
consistent snapshot.

## Releases

A pushed tag such as `v0.1.0` runs the release workflow and publishes Linux
(x86_64 and aarch64, static), macOS universal, and Windows (x64 and arm64)
archives. The Linux builds also include `.deb` and `.rpm` packages. The tag must
match `version` in `Cargo.toml`.

```bash
git tag -a v0.1.0 -m "Grapho 0.1.0"
git push origin v0.1.0
```

The binaries and packages are unsigned; macOS and Windows may warn on first
launch.

## Development

```bash
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
```

No frontend build is required; the HTML, CSS, and JavaScript are embedded into
the binary. See [AGENTS.md](AGENTS.md) for the architecture, security details,
and working notes.

## Current limits

Single user. No sharing, real-time collaboration, comments, images, tables, or
version history. No built-in authentication, TLS, or rate limiting.

## License

GPL-3.0. See [LICENSE](LICENSE).

Bundled fonts are under the SIL Open Font License; their license texts are in
`assets/fonts/`.
