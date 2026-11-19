# Grapho

Grapho is a small writing app that runs in the browser. It is one Rust binary with
no database, account system, or frontend build step. Documents are plain JSON
files on disk.

The home screen searches document titles and full text, highlights matching
passages, and shows previews in grid view. The editor has the formatting I use
most, holds images that can be
dragged into the text so the words flow around them and resized from their
corners, saves as you type, and can export to HTML, Markdown, PDF, or plain
text. The menu switches between a dark theme (the default) and a light one. Focus
mode, from the editor's menu, hides the toolbar and takes the page fullscreen so
only the writing and the menu button remain. Markdown mode, next to it, turns the
page into editable Markdown source; leaving it renders the document again, and
the file on disk stays the same JSON. Copying keeps the formatting, and a paste
from another program keeps the headings, lists, and emphasis it can represent.

## Installing

Prebuilt binaries for Linux, macOS, and Windows are attached to each
[release](https://github.com/igor-couto/grapho/releases). Package managers:

macOS and Linux, with Homebrew:

```bash
brew install igor-couto/grapho/grapho
```

Debian and Ubuntu:

```bash
curl -fsSL https://igor-couto.github.io/grapho/key.asc \
  | sudo gpg --dearmor -o /etc/apt/keyrings/grapho.gpg
echo "deb [signed-by=/etc/apt/keyrings/grapho.gpg] https://igor-couto.github.io/grapho stable main" \
  | sudo tee /etc/apt/sources.list.d/grapho.list
sudo apt update && sudo apt install grapho
```

Windows, with Scoop:

```powershell
scoop bucket add grapho https://github.com/igor-couto/scoop-grapho
scoop install grapho
```

Docker, on amd64, arm64, and armv7:

```bash
docker run -d --name grapho -p 127.0.0.1:25265:25265 \
  -v grapho-data:/data --restart unless-stopped \
  ghcr.io/igor-couto/grapho:latest
```

Ports, passwords, and building from a checkout are covered [below](#docker).

Anywhere else, unpack the tarball for your platform and put `grapho` on your
`PATH`. Every archive is signed; see [Verifying releases](#verifying-releases).

## Running from source

Requires Rust 1.89 or newer. On Windows, that means the MSVC toolchain with the
C++ build tools, or a GNU toolchain with MinGW-w64 on `PATH`.

```bash
git clone https://github.com/igor-couto/grapho.git
cd grapho
cargo run --release
```

Open http://127.0.0.1:25265. The compiled binary is `target/release/grapho`
(`grapho.exe` on Windows); it can be copied elsewhere and run on its own.

Documents go to a per-user directory: `$XDG_DATA_HOME/grapho` (usually
`~/.local/share/grapho`) on Linux, `~/Library/Application Support/Grapho` on
macOS, and `%LOCALAPPDATA%\Grapho` on Windows. A `data/` folder in the working
directory that already holds `.json` files is used instead, so an existing
checkout keeps its documents where they are. Set `GRAPHO_DATA_DIR=data` in a
fresh checkout if you want them next to the source.

The **Storage** page (the library's ⋯ menu, under Management) shows the folder
in use, how many documents it holds, how much room they take, and the free space
on that disk. Change the folder there and Grapho copies the library into it and
keeps writing there; the old folder is left untouched. The same page adds
backups — a folder, an SSH server, or a Google Drive folder — that receive a copy
of every save.

Every shortcut is listed on the **Shortcuts** page (the menu on any page). The
most useful: `Ctrl+O` opens documents by title, `Ctrl+S` saves now,
`Ctrl+K` adds a link, `Ctrl+B` / `Ctrl+I` / `Ctrl+U` format text,
`Ctrl+Shift+F` toggles focus mode, `Ctrl+Shift+M` switches between Markdown mode
and the normal rendered view, and `/` focuses the search box on the home screen.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `GRAPHO_ADDR` | `127.0.0.1:25265` | Address and port to listen on. |
| `GRAPHO_DATA_DIR` | per-user directory | Directory for document JSON files. Overrides the folder saved on the Storage page. |
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
restarting Grapho signs everyone out. Ten wrong passwords from one address in
fifteen minutes pause that address until the window ends, so a client guessing
cannot lock the owner out (restarting clears the pause).

The address is the one the connection came from, never `X-Forwarded-For`, which a
client can write. Behind a reverse proxy every request arrives from the proxy, so
all clients there share one pause.

There is still no TLS. Do not expose Grapho directly: terminate HTTPS in front of
it (Caddy, nginx, Traefik) or reach it through a VPN such as Tailscale or
WireGuard. The session cookie is marked `Secure` when the proxy sends
`X-Forwarded-Proto: https`.

## Docker

The image in the `docker run` above is a scratch image holding the static binary,
its license, and an empty `/data` directory, published for amd64, arm64, and
armv7. Pin a version instead of `latest` when you want to control upgrades, for
example `ghcr.io/igor-couto/grapho:0.1.1`.

`compose.yaml` builds the same image from a checkout:

```bash
docker compose up -d
```

That serves http://127.0.0.1:25265 and keeps documents in the `grapho-data`
volume. Use `GRAPHO_PORT=8080` to pick another host port (on PowerShell, set
`$env:GRAPHO_PORT` first). Without Compose, run `docker build -t grapho .` and
`docker run --rm -p 127.0.0.1:25265:25265 -v grapho-data:/data grapho`.

To require a password, generate the hash first and pass it in:

```bash
grapho hash-password
docker run --rm -p 127.0.0.1:25265:25265 \
  -e GRAPHO_PASSWORD_HASH='$argon2id$v=19$m=19456,t=2,p=1$...' \
  -v grapho-data:/data ghcr.io/igor-couto/grapho:latest
```

With Compose, the simple route is a file: write the hash to a file, mount it, and
set `GRAPHO_PASSWORD_HASH_FILE`. A hash in a Compose environment value needs every
`$` written as `$$`, because Compose interpolates.

The image listens on `0.0.0.0:25265` and stores documents in `/data`; override
either with `GRAPHO_ADDR` or `GRAPHO_DATA_DIR`. It runs as UID 65534, so a
bind-mounted host directory must be writable by that user.

## Data

Documents are stored in `GRAPHO_DATA_DIR/<document-id>.json`, which defaults to
the per-user directory above. Each file contains the title, sanitized HTML,
timestamps, and the paper width once you have resized it. Images are embedded as
base64 data URLs, so a document stays one self-contained file; photos are shrunk
in the browser first. A save replaces the file through a temporary file, so a
crash is unlikely to leave a half-written document.

Deleted documents stay in the data directory. Use **Recently deleted** in the
library menu to restore them with their original links. Grapho keeps them until
restored, and their files count toward the space used. Copy the whole directory
to back it up. Stop Grapho first if you want a consistent snapshot.

The folder is chosen in this order: `GRAPHO_DATA_DIR`, the folder saved on the
Storage page, a `data/` folder in the working directory that already holds
documents, and the per-user default. A folder chosen in the app is remembered in
`~/.config/grapho/config.json` on Linux, `~/Library/Preferences/Grapho/` on
macOS, and `%APPDATA%\Grapho\` on Windows, outside the data directory itself.
Changing the folder copies every document before switching, so a folder that
already holds another library's documents is refused rather than merged; choose
the previous folder again and Grapho updates its copies instead.

Backup locations are listed on the same page and configured in the same file.
Add one and Grapho copies your active library. Saves replace the mirrored copies,
deletions remove them, and restores copy the documents again. Use a local
folder, a mounted network share, or a Google
Drive, OneDrive, or Dropbox folder that its desktop app keeps in sync. Copies run
in the background, so a slow share never delays a save (a copy still queued when
Grapho stops gets a few seconds to finish). Removing a backup stops the mirroring
and leaves the files already in that folder alone. A backup folder that is the
data folder, sits inside it, or holds another library's documents is refused.

For a second machine, add an SSH server instead. Grapho copies over SFTP using
your OpenSSH `sftp` client, so the keys, agent, and known_hosts you already use
apply; it never asks for or stores a password, so use a key file or a key loaded
in your agent. The remote folder is an absolute path as the SSH account sees it,
and is refused if it already holds another library's documents. The first
connection remembers the server's host key; if it changes later, copies fail
until the old entry is removed.

Google Drive needs an OAuth client that belongs to you, because Grapho cannot
ship credentials for every installation. In the Google Cloud console create a
project, enable the Drive API, and add an OAuth client of type "Desktop app"
(the consent screen can stay in testing mode with your account as a test user).
Paste its client id and secret into the Google Drive form, name the folder, and
press Connect; Google asks for the `drive.file` scope, which limits Grapho to
files it creates. Open Grapho at `http://127.0.0.1:25265` for this, since Google
only redirects back to a loopback address. The refresh token is kept in
`secrets.json` beside the settings file (owner-only where the platform allows),
never in the data folder. Removing the connector leaves the Drive files alone.

## Releases

A pushed tag such as `v0.1.0` runs the release workflow and publishes Linux
(x86_64, aarch64, armv7, and riscv64), FreeBSD x86_64, macOS universal, and
Windows (x64 and arm64) builds. Linux x86_64 and aarch64 also get `.deb` and
`.rpm` packages. The same tag updates the apt repository and publishes the
container image. The tag must match `version` in `Cargo.toml`. The armv7,
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
and failed logins pause per address, so behind a reverse proxy they share the
proxy's address and one pause. PDF downloads use A4
pages and PDF's standard fonts; characters outside WinAnsi are replaced with
question marks. Backups mirror to a folder, an SSH server, or Google Drive; there
are no native OneDrive or Dropbox connectors, so use their synced folders. SSH
backups need OpenSSH's `sftp` client on the machine running Grapho, which the
container image does not include, and Google Drive needs a browser on the same
machine to finish its sign-in.

## License

GPL-3.0. See [LICENSE](LICENSE).

Bundled fonts are under the SIL Open Font License; their license texts are in
`assets/fonts/`.

### Author

* **Igor Couto** - [igor.fcouto@gmail.com](mailto:igor.fcouto@gmail.com)
