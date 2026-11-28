# Grapho

Grapho is a small writing app that runs in the browser. It is one Rust binary with
no database, account system, or frontend build step. Documents are Markdown
files and drawings are JSON files, with one metadata index for the library.

The home screen searches document titles and full text, highlights matching
passages, and shows previews in grid view. The editor has the formatting I use
most, holds images that can be
dragged into the text so the words flow around them and resized from their
corners, inserts tables (with a header row, Tab between cells, a hover button
on each cell for adding or removing rows and columns, and Ctrl+Alt+Right /
Ctrl+Alt+Down for a quick column or row), saves as you type, and can export to
HTML, Markdown, PDF, or plain text. The menu switches between a dark theme (the
default) and a light one. Focus
mode, from the editor's menu, hides the toolbar and takes the page fullscreen so
only the writing and the menu button remain. Markdown mode, next to it, turns the
page into editable Markdown source. Leaving it renders the document again.
Copying keeps the formatting, and a paste
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
directory that already holds Grapho Markdown documents is used instead, so an existing
checkout keeps its documents where they are. Set `GRAPHO_DATA_DIR=data` in a
fresh checkout if you want them next to the source.

Open **Storage** from the library's menu to manage folders and backups.
Under **Spaces**, create a named group and optionally give it its own folder
for Markdown and images. Existing documents are in **General**. Pick a Space
in the library to browse, search, and write in it. Use **Move to Space** in a
document's menu to change its group while keeping its link.

When creating a Space, choose an existing folder and check **Import existing
Markdown files** to add its UTF-8 `.md` files. Grapho uses the filenames as
titles and edits the original files in place. Import reads the selected folder
only. Images linked from other files need to be added through the editor.

Enable **Boards** under **Extensions** in the library menu. **New Document**
then offers **Document** or **Board**. Click the board title to rename it.
Add columns and cards, click a card to edit it, or drag cards to reorder or
move them. Hover a card to reveal its trash icon, which deletes the card after
a confirmation. On a touch screen, drag using the grip beside it.
Choose **Edit Markdown** to edit the source. The first `#` heading supplies
the board's title.
Text before the first column describes the board, each `##` heading starts a
column, and `- Title: Description` adds a card. Put a longer Markdown
description inside backtick fences below its card. Board and Markdown changes
save automatically to the same file. A document's ⋯ menu offers **Convert to
board** while Boards is on: Grapho keeps the document's Markdown as the board
source, so it only converts when that Markdown already has board columns and
the document has no images. When it does not fit, Grapho says so and leaves the
document as it was. The extension switches belong to the Grapho server, so
every browser and device that opens the library sees the same ones. Existing
boards open in Markdown when Boards is off.

Enable **Draw** under **Extensions**, then choose **Drawing** in **New Document**.
Use a mouse, pen, or finger to sketch, add shapes, connect them with arrows,
or write text. Select an object to move it, or use the eraser to remove it.
Paste an image, drag an image file onto the canvas, or use **Add image** to
embed a picture in the drawing.
Choose **Background** under **More actions** to set the pattern and colors for
that drawing.
Drawings autosave to files such as `Workshop sketch.drawing.json`. Older
pencil drawings open normally and keep their links.

Every shortcut is listed on the **Shortcuts** page (the menu on any page). The
most useful: `Ctrl+O` opens documents by title, `Ctrl+S` saves now,
`Ctrl+K` adds a link, `Ctrl+B` / `Ctrl+I` / `Ctrl+U` format text,
`Ctrl+Shift+F` toggles focus mode, `Ctrl+Shift+M` switches between Markdown mode
and the normal rendered view, and `/` focuses the search box on the home screen.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `GRAPHO_ADDR` | `127.0.0.1:25265` | Address and port to listen on. |
| `GRAPHO_DATA_DIR` | per-user directory | Directory for Markdown documents and their metadata. Overrides the folder saved on the Storage page. |
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

Text documents and boards use Markdown bodies named after their title, such as
`Project Notes.md`. Drawings use title-based `.drawing.json` files. Grapho
replaces characters that filenames cannot use and adds a number when a name is
taken. Renaming in Grapho changes the filename.
The shared `metadata.json` keeps filenames, stable document IDs, Spaces, dates,
paper widths, and image layout. Images sit beside the Markdown and use relative
links. A few rich-text features, such as centered paragraphs, use HTML inside
the Markdown. Tables are written as GFM pipe tables for other Markdown tools;
one whose cells carry rich HTML the pipe form cannot hold falls back to safe
HTML in the same file. Stop Grapho before editing Markdown by hand, and rename
documents in Grapho so the index stays in sync. Version 1 Markdown libraries
open in place. The next document or Space change writes the current index,
and existing UUID filenames switch to title-based names when their documents
change. Libraries from before Markdown storage require a fresh data folder.

Deleted documents stay in the data directory. Use **Recently deleted** in the
library menu to restore them with their original links. Grapho keeps them until
restored, and their files count toward the space used. Copy the main and any
separate Space folders for a manual backup. Stop Grapho first if you want a
consistent snapshot.

**Add to dictionary** saves words for body spellcheck in `spelling-words.json`
in the data directory, with one list per Space. A word added while writing in a
Space is accepted throughout that Space; documents in General use their own
list. The lists are shared across browsers on the same Grapho server and follow
the library when you move the data folder. The library's **Extensions**
switches live in `extensions.json` there too, so every browser sees the same
ones.

The folder is chosen in this order: `GRAPHO_DATA_DIR`, the folder saved on the
Storage page, a `data/` folder in the working directory that already holds
documents or Spaces, and the per-user default. A folder chosen in the app is remembered in
`~/.config/grapho/config.json` on Linux, `~/Library/Preferences/Grapho/` on
macOS, and `%APPDATA%\Grapho\` on Windows, outside the data directory itself.
Changing the main folder copies its files before switching. Dedicated Space
folders keep their paths. Changing a Space's folder copies its files before
switching and keeps any previous dedicated folder as a copy. Leave the Space's
folder blank to use the main folder.
If a Space folder is unreachable at startup, Grapho marks that Space as
unavailable and opens the rest of the library. Reconnect the folder and
restart Grapho to load the Space.

Backup locations are listed on the same page and configured in the same file.
Add one and Grapho mirrors active documents and images from all Spaces together
with their grouping. Mirrors use document IDs for filenames so each backup can
track the same copy after a rename. A restored mirror starts with all Spaces
using its main folder. Saves update the mirrored copies, deletions remove them, and restores
copy the documents again. Use a local
folder, a mounted network share, or a Google
Drive, OneDrive, or Dropbox folder that its desktop app keeps in sync. Copies run
in the background, so a slow share never delays a save (a copy still queued when
Grapho stops gets a few seconds to finish). After a failed copy, the next document
change retries missed writes and deletions, even after a restart. Removing a
backup stops the mirroring and leaves the files already in that folder alone.
Keep the data folder and backup folders separate when adding a backup or moving
the library. Neither can contain the other. A backup folder holding another
library's documents is refused.

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

Single user. No sharing, real-time collaboration, comments, or version
history. Tables always have a first-row header and hold inline text only: no
merged cells, pictures in cells, nested tables, or column widths to drag, and at
most 12 columns. The optional password signs one person in: there are no
accounts, no TLS,
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

* **Igor Couto**
