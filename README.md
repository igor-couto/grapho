# Grapho

Grapho is a small writing app that runs in the browser. It is one Rust binary with
no database, account system, or frontend build step. Documents are plain JSON
files on disk.

The home screen lists and searches documents. The editor has the formatting I use
most, holds images that can be dragged into the text so the words flow around
them and resized from their corners, saves as you type, and can export to HTML,
Markdown, or plain text. Light and dark themes are included.

## Running

Requires Rust 1.89 or newer. On Windows, that means the MSVC toolchain with the
C++ build tools, or a GNU toolchain with MinGW-w64 on `PATH`.

```bash
git clone https://github.com/igor-couto/grapho.git
cd grapho
cargo run --release
```

Open http://127.0.0.1:25265. The first run creates a `data/` directory in the
project root. The compiled binary is `target/release/grapho` (`grapho.exe` on
Windows); it can be copied elsewhere and run on its own.

Useful shortcuts: `Ctrl+S` saves now, `Ctrl+K` adds a link, `Ctrl+B` / `Ctrl+I` /
`Ctrl+U` format text, and `/` focuses the search box on the home screen.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `GRAPHO_ADDR` | `127.0.0.1:25265` | Address and port to listen on. |
| `GRAPHO_DATA_DIR` | `data` | Directory for document JSON files. |
| `GRAPHO_PASSWORD_HASH` | unset | Argon2id hash from `grapho hash-password`. Turns on the login screen. |
| `GRAPHO_PASSWORD_HASH_FILE` | unset | File containing that hash. Wins over `GRAPHO_PASSWORD_HASH`. |

The default port is 25265 (it spells `BLANK` on a phone keypad), chosen so it is
unlikely to collide with another local server.

For example, to use Grapho from other devices on your network:

```bash
GRAPHO_ADDR=0.0.0.0:25265 cargo run --release
```

On PowerShell, run `$env:GRAPHO_ADDR = "0.0.0.0:25265"` first.

Grapho has an optional password (below) but no TLS. Keep it on a trusted network,
or put a VPN or an HTTPS reverse proxy in front of it. If you use a proxy, preserve
the `Host` header.

## Password

Grapho can ask for a password before it shows anything. Only a hash is stored:

```bash
grapho hash-password
```

Type a password of at least 12 characters (asked twice, not echoed) and the
command prints a line beginning with `$argon2id$`. Put it in
`GRAPHO_PASSWORD_HASH`:

```bash
GRAPHO_PASSWORD_HASH='$argon2id$v=19$m=19456,t=2,p=1$...' grapho
```

`GRAPHO_PASSWORD_HASH_FILE` reads the same hash from a file, which keeps it out of
shell history and `docker inspect`. The hash is an Argon2id verifier, so the
password itself is never written anywhere. To change it, generate a new hash and
restart.

Sessions are random tokens kept in memory and sent in an `HttpOnly`,
`SameSite=Strict` cookie. A session lasts 30 days from its last use, and
restarting Grapho signs everyone out. Ten wrong passwords in fifteen minutes pause
logins until that window ends (restarting clears the pause).

There is still no TLS. Do not expose Grapho directly: terminate HTTPS in front of
it (Caddy, nginx, Traefik) or reach it through a VPN such as Tailscale or
WireGuard. The session cookie is marked `Secure` when the proxy sends
`X-Forwarded-Proto: https`.

## Docker

`compose.yaml` runs Grapho in a container; the image is a scratch image with the
static binary, its license, and an empty `/data` directory.

```bash
docker compose up -d
```

That serves http://127.0.0.1:25265 and keeps documents in the `grapho-data`
volume. Use `GRAPHO_PORT=8080` to pick another host port (on PowerShell, set
`$env:GRAPHO_PORT` first). Without Compose, run
`docker build -t grapho .` and
`docker run --rm -p 127.0.0.1:25265:25265 -v grapho-data:/data grapho`.

To require a password, generate the hash first and pass it in:

```bash
grapho hash-password
docker run --rm -p 127.0.0.1:25265:25265 \
  -e GRAPHO_PASSWORD_HASH='$argon2id$v=19$m=19456,t=2,p=1$...' \
  -v grapho-data:/data grapho
```

With Compose, the simple route is a file: write the hash to a file, mount it, and
set `GRAPHO_PASSWORD_HASH_FILE`. A hash in a Compose environment value needs every
`$` written as `$$`, because Compose interpolates.

The image listens on `0.0.0.0:25265` and stores documents in `/data`; override
either with `GRAPHO_ADDR` or `GRAPHO_DATA_DIR`. It runs as UID 65534, so a
bind-mounted host directory must be writable by that user.

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
(x86_64, aarch64, armv7, and riscv64), FreeBSD x86_64, macOS universal, and
Windows (x64 and arm64) builds. Linux x86_64 and aarch64 also get `.deb` and
`.rpm` packages. The tag must match `version` in `Cargo.toml`. The armv7,
riscv64, and FreeBSD builds are cross-compiled and not run in CI.

```bash
git tag -a v0.1.0 -m "Grapho 0.1.0"
git push origin v0.1.0
```

The macOS and Windows builds are not signed with a platform certificate, so
they may warn on first launch.

## Verifying releases

`release-signing-key.asc` is the public key. Every archive, package, and
`SHA256SUMS.txt` has a detached `.asc` signature.

```bash
gpg --import release-signing-key.asc
gpg --verify SHA256SUMS.txt.asc SHA256SUMS.txt
sha256sum --check SHA256SUMS.txt
```

Check the key fingerprint out of band before trusting it.

## Development

```bash
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
```

No frontend build is required; the HTML, CSS, and JavaScript are embedded into
the binary. The editor lays out its own lines with a vendored copy of
[pretext](https://github.com/chenglou/pretext) (MIT, `assets/pretext/`), so text
can flow around images instead of relying on CSS floats. See
[AGENTS.md](AGENTS.md) for the architecture, security details,
and working notes.

## Current limits

Single user. No sharing, real-time collaboration, comments, tables, or version
history. The optional password signs one person in: there are no accounts, no TLS,
and failed logins pause globally rather than per address.

## License

GPL-3.0. See [LICENSE](LICENSE).

Bundled fonts are under the SIL Open Font License; their license texts are in
`assets/fonts/`.
