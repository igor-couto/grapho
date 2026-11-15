# AGENTS.md

Working notes for Grapho. Read this before changing the app, especially if you
are an AI coding agent.

## Scope

Grapho is a single-user document editor: one Rust binary, plain browser assets,
and JSON files on disk. It should stay easy to run and easy to understand.

Do not add accounts, sharing, collaboration, a database, or a frontend framework
unless the user asks for them. The current features are the product, not a
starting point for every feature the app could have.

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
  one rust accent, Literata for writing, Inter for controls. Extend it; do not add
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
src/main.rs     configuration, startup, graceful shutdown
src/api.rs      routes, static assets, security headers, same-origin check
src/store.rs    document model, JSON persistence, HTML sanitization
src/assets.rs   embedded HTML/CSS/JS/font lookup
assets/         browser UI; no build step
assets/fonts/   bundled Inter/Literata files and their licenses
```

Data flow is deliberately simple:

1. The browser loads static HTML/CSS/JS.
2. The UI uses the JSON API for document operations.
3. The Rust store keeps documents in an in-memory map and writes each change to
   `GRAPHO_DATA_DIR/<uuid>.json`.
4. Documents use a simple versioned JSON format. Add `#[serde(default)]` when
   extending it, and preserve existing files.

## Invariants

These should not be casually changed:

- Stored HTML is sanitized on save and again on load. The allowlist in
  `store.rs` is the trust boundary.
- Formatting must produce semantic tags (`<b>`, `<i>`, `<u>`, headings, lists),
  never inline styles. The Content-Security-Policy forbids inline styles; do not
  turn on `styleWithCSS`.
- Rich HTML paste is reduced to plain text on purpose. Keep it that way unless
  the user asks for sanitized paste support.
- The CSP, frame denial, no-referrer policy, and same-origin mutation check are
  part of the app. Do not loosen them for convenience.
- The server binds to loopback by default and has no authentication or TLS. Keep
  deployment warnings honest.
- Writes go through the temporary-file-and-replace path in `store.rs`. Do not
  introduce a database or write directly to a live document file.

## Checks

Run these before calling a change done:

```bash
cargo test --all-targets
cargo clippy --all-targets -- -D warnings
cargo fmt --all -- --check
```

`node --check assets/home.js`, `node --check assets/editor.js`, and
`node --check assets/theme.js` are useful syntax checks when Node is available;
Node is not a runtime dependency.

For UI changes, start the app and check the real browser flow at least once:

1. Create a document, type, wait for "Saved", reload, and confirm the content.
2. Go back to the library and confirm search, rename, and delete still work.
3. Export HTML and check that the title and body are present.
4. Try a narrow mobile viewport and confirm there is no horizontal overflow.
5. Watch the console for errors or CSP violations.

On a Windows GNU toolchain, make sure MinGW's `bin` directory (with `dlltool.exe`
and `ld.exe`) is on `PATH`. With the MSVC toolchain, install the Visual Studio C++
build tools.

The default server address is `127.0.0.1:3000`. Do not start a second server on
that port while one is running.

## Housekeeping

- Do not modify or delete user documents in `data/`; it is gitignored and not a
  fixture directory. Remove any test documents you create.
- Do not commit, amend, or push unless the user asks.
- Avoid giant refactors and unrelated formatting changes. Keep the diff focused.
- If a change makes the app heavier or adds UI, explain why it is worth it.
