# AGENTS.md

Working notes for Grapho. Read this before changing the app, especially if you
are an AI coding agent.

## Scope

Grapho is a single-user document editor: one Rust binary, plain browser assets,
and JSON files on disk. It should stay easy to run and easy to understand.

Do not add accounts, sharing, collaboration, a database, or a frontend framework
unless the user asks for them. The current features are the product, not a
starting point for every feature the app could have.

The optional password is not an account system: one shared secret, no users, no
roles, no per-document permissions. Keep it that way.

## Ground rules

### Speed and efficiency

- Keep the dependency graph small. A new crate has to pay for its compile time,
  binary size, and maintenance cost. Do not add one for something a few lines of
  code can do clearly.
- No JavaScript framework, CSS framework, bundler, icon package, remote font, or
  CDN. The UI is plain HTML/CSS/JS, and the fonts are bundled locally.
- Do not add polling, background sync, or extra requests. The library loads once,
  and the editor saves only after content changes.
- Keep keystroke work cheap. Client-side word counts are local; saves are
  debounced. Do not turn typing into synchronous I/O or a request per keystroke.
- Do not optimize on instinct. The realistic target is a person with a few hundred
  documents. Measure before introducing caches or more machinery.
- All browser assets are compiled into the binary with `include_str!` /
  `include_bytes!`. After editing anything under `assets/` or `src/`, rebuild or
  restart the server. A running process will not pick up the change.

### Clean UI

- Start from the existing visual system in `assets/app.css`: warm paper, dark ink,
  one blue accent, Literata for writing, Inter for controls. Extend it; do not add
  a second design language.
- No feature bloat. The home screen and editor should stay focused. Avoid adding
  dashboards, template galleries, onboarding tours, settings pages, extra side
  panels, or promotional sections unless asked.
- Every new control has to earn its space. Prefer an existing menu, a keyboard
  shortcut, or no control at all.
- Use inline SVG icons. Do not add an icon library. Decoration should come from
  typography and spacing, not piles of borders, shadows, or gradients.
- Keep motion short and functional. Respect `prefers-reduced-motion`.
- Check both a desktop width and a 390px-wide viewport. There should be no
  horizontal overflow, focus states must remain visible, and primary actions must
  not be hidden behind hover on touch devices.
- Nothing should block typing or make the editor feel busy.

### Documentation

- The README is for someone who wants to run Grapho. Keep it short and practical:
  what it is, how to run it, configuration, data, and real limitations. Aim for
  under about 80 lines.
- Write plainly. No marketing copy, badges, emoji, breathless adjectives, fake
  personas, or exhaustive feature inventories. Prefer short paragraphs, concrete
  commands, and specific facts.
- If setup, configuration, data, or deployment behavior changes, update the
  README. Do not document features that do not exist.
- Put engineering context and agent instructions in this file, not the README.
- Do not create extra Markdown files unless they solve a recurring need.

## Code map

```text
src/main.rs       configuration, CLI, startup, graceful shutdown
src/api.rs        routes, static assets, security headers, same-origin check
src/auth.rs       password gate: Argon2id, sessions, throttling, cookies
src/store.rs      document model, JSON persistence, HTML sanitization
src/assets.rs     embedded HTML/CSS/JS/font lookup
assets/           browser UI; no build step (login.html is the password gate)
assets/doc/       the editor: model, layout, view, and input
assets/pretext/   vendored text layout engine (MIT); do not edit
assets/fonts/     bundled Inter/Literata files and their licenses
Dockerfile        static musl binary on a scratch runtime image
compose.yaml      local container: loopback port and grapho-data volume
Cross.toml        cross-rs target images
```

Data flow is deliberately simple:

1. The browser loads static HTML/CSS/JS. When a password is configured, every
   page and API call also needs a session cookie.
2. The UI uses the JSON API for document operations.
3. The Rust store keeps documents in an in-memory map and writes each change to
   `GRAPHO_DATA_DIR/<uuid>.json`.
4. Documents use a simple versioned JSON format. Add `#[serde(default)]` when
   extending it, and preserve existing files.

The default data directory is per-user, not the working directory:
`$XDG_DATA_HOME/grapho` or `~/.local/share/grapho` on Linux,
`~/Library/Application Support/Grapho` on macOS, and `%LOCALAPPDATA%\Grapho` on
Windows. Package managers start the binary from arbitrary directories
(`brew services` from `/`, a Chocolatey shim from `System32`), so a relative
default would scatter documents. A `./data` folder that already holds `.json`
files wins, which keeps checkouts and copied folders portable, and
`GRAPHO_DATA_DIR` overrides everything. The container image sets that variable
to `/data` explicitly.

## Editor architecture

The editor does not use `contenteditable`. `assets/doc/input.js` owns the block
model and the selection, `layout.js` turns blocks into positioned lines with
pretext, and `view.js` paints those lines plus the caret and selection.
`model.js` converts the block model to and from the stored HTML, which is
unchanged.

- Every line comes from `prepare`/`layoutNextLineRange` or
  `prepareRichInline`/`layoutNextRichInlineLineRange`. Do not reintroduce browser
  text wrapping inside the document.
- Typography lives twice: the font, size, and line-height constants in
  `layout.js` are what pretext measures, and the matching `.doc-line` classes in
  `app.css` paint them. Change both together, or carets and selections drift.
- Images are blocks. `mode: "left" | "right"` floats one over the following lines
  by narrowing them; `mode: "block"` centres it with its own vertical space;
  `mode: "free"` places it at `x` (from the column's left) and `y` (from the top
  of the document's content), stored as `class="free" data-x data-y`. Lines that
  meet an image narrow to its emptier side, clear it when neither side is usable,
  and clear all images that meet a line at once. Code blocks wrap their lines the
  same way. If several wrapped images keep moving each other's anchors, the last
  pass pins them in place, so no line can end up beneath an image.
- Dragging writes the new absolute position directly; arrow keys move a selected
  image by 4 px (24 with Shift). A selected image shows four corner handles;
  dragging one keeps the opposite corner fixed, preserves the aspect ratio, and
  stores the rendered width as `data-width` (the natural `width`/`height` stay).
  Holding Alt scales around the image's centre instead. Resizing turns the image
  free, so the text reflows beside it.
- Edits go through `DocEditor.commit()`, which snapshots undo state, re-lays out,
  and repaints. Do not mutate `blocks` in place.
- The hidden `<textarea>` only captures keystrokes, IME, and clipboard events; its
  value is cleared after every event.
- Known gaps: no native spellcheck, screen readers get the painted text but not a
  text-editing surface, printing the editor prints the painted page, image
  resizing needs a pointer, and HTML or Markdown exports put free-positioned
  images back into the text flow.

## Invariants

These should not be casually changed:

- Stored HTML is sanitized on save and again on load. The allowlist in
  `store.rs` is the trust boundary.
- Images are embedded in that HTML as base64 data URLs. The sanitizer accepts only
  PNG, JPEG, WebP, and GIF data URLs on `img src`, never remote URLs: opening a
  document must not touch the network.
- Formatting is stored as semantic tags (`<b>`, `<i>`, `<u>`, headings, lists),
  never inline styles. The Content-Security-Policy forbids inline styles.
- The stored HTML is the interchange format between the editor and older
  documents. `parseDocument`/`serializeDocument` must round-trip it; test with
  documents written by earlier versions.
- Rich HTML paste is reduced to plain text on purpose. Image files are the one
  exception; keep it that way unless the user asks for sanitized paste support.
- The CSP, frame denial, no-referrer policy, and same-origin mutation check are
  part of the app. Do not loosen them for convenience.
- The server binds to loopback by default and has no TLS. Password login is
  optional; keep the startup warnings honest about what is and is not protected.
- The password exists only as an Argon2id hash from `GRAPHO_PASSWORD_HASH` or
  `GRAPHO_PASSWORD_HASH_FILE`. Never accept, store, or log a plaintext password,
  and never write the hash into the data directory.
- Session tokens are 32 random bytes, live in memory, and travel only in the
  `HttpOnly`, `SameSite=Strict` cookie. Never put one in a URL, in `localStorage`,
  or in the document store, and never make the cookie readable from JavaScript.
- Every route that reads or changes a document is registered on the protected
  router in `api.rs`. The public routes are `/login`, `/api/session`,
  `/api/health`, and `/assets/*`; a new public route needs a reason.
- Argon2 runs on a blocking thread behind a single permit, failed logins are
  throttled, and authenticated responses are `no-store` with `Vary: Cookie`. Keep
  all three when touching the login code. Sessions and the failure counter are
  in memory on purpose: a restart signs everyone out and clears a login pause.
- Login redirects carry the destination in `next` as one encoded query value. The
  browser only follows it when it is a path on this server (`/login.js`
  `nextPath()`); do not turn it into an open redirect.
- Writes go through the temporary-file-and-replace path in `store.rs`. Do not
  introduce a database or write directly to a live document file.

## Releases

A pushed `v<version>` tag runs `.github/workflows/release.yml`. The tag must
match `Cargo.toml`. The workflow builds Linux, macOS, and Windows binaries,
adds `.deb`/`.rpm` packages, and writes `SHA256SUMS.txt`. It does not publish a
container image; the `Dockerfile` is built on demand.

The `cross` job adds armv7 Linux and x86_64 FreeBSD builds using a pinned build
of cross-rs. Those cross-compiled binaries are not executed in CI. FreeBSD uses
Rust 1.89 because its cross image is Ubuntu 20.04 with glibc 2.31, which cannot
run build scripts from newer toolchains.

riscv64 was dropped from the release matrix: `riscv64gc-unknown-linux-musl` is
the only musl target whose standard library is built for dynamic linking
(`rustc --print cfg` reports no `crt-static` feature for it), so its binary
fails the static check the other musl builds pass. Restoring it means forcing
`-C target-feature=+crt-static` for that target and verifying the result runs.

Signing uses repository secrets:

- `GPG_PRIVATE_KEY`: ASCII-armored private signing key.
- `GPG_PASSPHRASE`: its passphrase, if it has one.

The workflow signs every archive, package, and `SHA256SUMS.txt` with armored
detached `.asc` signatures and uploads `release-signing-key.asc`. It fails
before publishing when `GPG_PRIVATE_KEY` is missing. Keep the private key out of
the repository and logs.

### Distribution

Installers come from the same tagged release, so the asset names, archive
layout, and checksums in `packaging/` must match `release.yml`. Every channel
needs anonymous HTTPS downloads: nothing can be published while the repository
is private.

- `packaging/homebrew/Formula/grapho.rb` is the tap formula. Copy it to
  `Formula/grapho.rb` in `igor-couto/homebrew-grapho` and replace the three
  `sha256` placeholders with the `grapho` lines from that tag's
  `SHA256SUMS.txt`.
- `packaging/scoop/bucket/grapho.json` is the Scoop manifest. Copy it to
  `bucket/grapho.json` in `igor-couto/scoop-grapho` and update the two `hash`
  values and `extract_dir` names. `extract_dir` must match the top-level folder
  inside the Windows zip, which is `grapho-<version>-windows-<arch>`.
- `packaging/winget/manifests/i/IgorCouto/Grapho/<version>/` holds the three
  manifests submitted to `microsoft/winget-pkgs`; the directory path must match
  the package identifier. `winget validate --manifest <dir>` checks them
  locally. Installer hashes are uppercase hex, and each architecture needs its
  own `NestedInstallerFiles` path because the zip folder name contains the
  version.
- `packaging/chocolatey/` holds the nuspec and `tools/chocolateyinstall.ps1`;
  `choco pack grapho.nuspec` builds `grapho.<version>.nupkg`. Nothing is bundled:
  the script downloads the release zip, verifies its SHA256, and shims the
  binary inside the zip's top-level folder. Pushing to community.chocolatey.org
  needs a verified account and an API key, and the package goes through human
  moderation.

The Windows release links the MSVC runtime dynamically: the binary imports
`VCRUNTIME140.dll` and `api-ms-win-crt-*`. So the VC++ 2015-2022 redistributable
has to be installed; the Chocolatey package declares a `vcredist140`
dependency for that reason, and Scoop and winget rely on the user's machine
already having it. Building the Windows targets with
`-C target-feature=+crt-static` removes the dependency entirely, which is the
better fix and would let every channel drop its redistributable handling.

## Checks

Run these before calling a change done:

```bash
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
```

`docker build -t grapho .` builds the container image: a static musl binary on a
scratch image with an empty `/data` directory.

`node --check assets/home.js`, `node --check assets/editor.js`,
`node --check assets/login.js`, and `node --check assets/theme.js` are useful
syntax checks when Node is available; Node is not a runtime dependency.

For UI changes, start the app and check the real browser flow at least once:

1. Create a document, type, wait for "Saved", reload, and confirm the content.
2. Go back to the library and confirm search, rename, and delete still work.
3. Export HTML and check that the title and body are present.
4. Try a narrow mobile viewport and confirm there is no horizontal overflow.
5. Watch the console for errors or CSP violations.
6. With `GRAPHO_PASSWORD_HASH` set, sign in, check the wrong-password message,
   confirm the editor and library work, and sign out from the library menu.

On a Windows GNU toolchain, make sure MinGW's `bin` directory (with `dlltool.exe`
and `ld.exe`) is on `PATH`. With the MSVC toolchain, install the Visual Studio C++
build tools.

The default server address is `127.0.0.1:25265`. The port spells `BLANK` on a
phone keypad and is unassigned, so it should not collide with common dev servers.
Do not start a second server on that port while one is running.

## Housekeeping

- Do not modify or delete user documents in `data/`; it is gitignored and not a
  fixture directory. Remove any test documents you create.
- Do not commit, amend, or push unless the user asks.
- Avoid giant refactors and unrelated formatting changes. Keep the diff focused.
- If a change makes the app heavier or adds UI, explain why it is worth it.
