# AGENTS.md

Working notes for Grapho. Read this before changing the app, especially if you
are an AI coding agent.

## Scope

Grapho is a single-user document editor: one Rust binary, plain browser assets,
and Markdown documents on disk. It should stay easy to run and easy to understand.

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
- Do not add polling, background sync, or speculative requests. The library
  loads once, search waits for a pause in typing, and the editor saves only
  after content changes.
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
- Dark is the default theme; the menu's Light/Dark choice is remembered in
  `localStorage` and wins over the default. Do not make the default follow
  `prefers-color-scheme`.
- No feature bloat. The home screen and editor should stay focused. Avoid adding
  dashboards, template galleries, onboarding tours, settings pages, extra side
  panels, or promotional sections unless asked.
- Every new control has to earn its space. Prefer an existing menu, a keyboard
  shortcut, or no control at all.
- Use inline SVG icons. Do not add an icon library. Decoration should come from
  typography and spacing, not piles of borders, shadows, or gradients.
- Keep motion short and functional. Menus fade and settle into place over
  180ms (`menu-in` in `app.css`); `editor.js` names the side a fixed menu landed
  on in `data-side` and the grid card menu flips the sign in CSS, so a menu above
  its trigger rises out of it instead of dropping away. Closing is instant so it
  never delays the next action. Respect `prefers-reduced-motion`.
- Check both a desktop width and a 390px-wide viewport. There should be no
  horizontal overflow, focus states must remain visible, and primary actions must
  not be hidden behind hover on touch devices.
- Nothing should block typing or make the editor feel busy.
- Clickable buttons have opaque backgrounds. Bars, panels, fields, and cards may
  stay translucent, but a button's fill never uses `transparent` or an alpha
  color, even at rest; pick the solid color of the surface it sits on so flat
  toolbars stay flat.

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
src/store.rs      document model, library persistence, HTML sanitization
src/markdown.rs   Markdown bodies and relative image attachments on disk
src/settings.rs   data folder rules and the remembered folder choice
src/backup.rs     backup connectors: a background mirror of every save
src/sftp.rs       the system sftp client, driven in batch mode for SSH backups
src/drive.rs      Google Drive: loopback OAuth, token cache, and Drive calls
src/secrets.rs    connector secrets (OAuth client secret, refresh token)
src/disk.rs       free space for the storage page (statvfs / GetDiskFreeSpaceEx)
src/assets.rs     embedded HTML/CSS/JS/font lookup
assets/           browser UI; no build step (login.html is the password gate)
assets/doc/       the editor: model, layout, view, input, images, and PDF export
assets/doc/clipboard.js     rich copy/paste: selection HTML and sanitized pasted HTML
assets/doc/markdown.js      Markdown mode: rich blocks <-> editable source
assets/doc/markdown-edit.js Markdown mode: toolbar commands edit the source
assets/menu.js      the page menu on storage, version, shortcuts, and not-found
assets/home.js      the library: listing, search, view, sort, rename, duplicate, delete
assets/quick-open.js  the Ctrl+O document search, shared by every page except the gate
assets/shortcuts.html  the page listing every editor and app shortcut
assets/storage.html  the page for the data folder and backup connectors
assets/icons/     standalone SVG sources for the icons the pages inline
assets/pretext/   vendored text layout engine (MIT); do not edit
assets/fonts/     bundled Inter/Literata files and their licenses
build.rs          git tag, commit, and commit date for /version
Dockerfile        static musl binary on a scratch runtime image
compose.yaml      local container: loopback port and grapho-data volume
Cross.toml        cross-rs target images
test/             browser tests for the editor and a real-server round trip
```

Data flow is deliberately simple:

1. The browser loads static HTML/CSS/JS. When a password is configured, every
   page and API call also needs a session cookie.
2. The UI uses the JSON API for document operations.
3. The Rust store keeps documents in an in-memory map. A title-based `.md` file
   holds the body. The shared `metadata.json` maps stable UUIDs to filenames and
   stores titles, dates, deletion state and layout. Relative links point to image
   files beside the Markdown.
4. The store reads the indexed files and sanitizes Markdown on startup. Keep the
   index versioned and use `#[serde(default)]` when adding optional fields.
   Earlier storage formats are unsupported.

Spaces are defined in the same `metadata.json`, which lives in the main data
folder. Documents without a Space ID belong to General. A named Space can use
the main folder or an absolute path configured in Storage. Bodies and images
move together while the document ID stays stable. Use the store's folder lookup
for file access. A move copies files first and commits the shared index
before cleaning up the previous location. Renames use the same order, and
case-only edits preserve filename capitalization. Backups keep UUID filenames,
retain all groups in their index, and omit machine-specific Space paths.
Creating a Space can opt into importing the folder's existing Markdown. Read
regular top-level `.md` files using the usual Markdown parser and sanitizer,
keep the filenames and bodies, and commit all document entries with the Space
in one metadata write. Queue their IDs as one batch for the backup worker.

The default data directory is per-user, not the working directory:
`$XDG_DATA_HOME/grapho` or `~/.local/share/grapho` on Linux,
`~/Library/Application Support/Grapho` on macOS, and `%LOCALAPPDATA%\Grapho` on
Windows. Package managers start the binary from arbitrary directories
(`brew services` from `/`, a Chocolatey shim from `System32`), so a relative
default would scatter documents. A `./data` folder with documents or Spaces
in its index wins, which keeps checkouts and copied folders portable, and
`GRAPHO_DATA_DIR` overrides everything. The container image sets that variable
to `/data` explicitly.

The folder is chosen in this order, and `settings.rs` owns the rules:
`GRAPHO_DATA_DIR`, the folder saved on the Storage page, `./data` when it holds
documents, and the per-user default. A saved folder is stronger than `./data`
because choosing it is an explicit instruction, and the environment stays
strongest: the Storage page refuses to change a folder that the environment
selected. The saved value lives outside the data directory, in the per-user
configuration directory (`~/.config/grapho/config.json`,
`~/Library/Preferences/Grapho/config.json`, `%APPDATA%\Grapho\config.json`), so
moving the documents cannot lose the record of where they went. A missing,
unreadable, or malformed settings file just means "no saved choice".

The Storage page (`/storage`, protected like the documents because it reveals a
filesystem path) shows the folder, document count, bytes used, and free space
from `statvfs` or `GetDiskFreeSpaceExW`. Changing the main folder copies its
documents, dictionary, and shared metadata before the store switches. The
previous files stay in place and Spaces with dedicated folders keep their
paths. A target can be empty or hold the library's own copies.
`GRAPHO_DATA_DIR` sets the main folder when supplied.

The same page adds backup connectors: a folder that receives a copy of every
save, an SSH server reached over SFTP, or a Google Drive folder. A OneDrive or
Dropbox folder works through its desktop sync client, and a mounted network share
works like any other folder. Adding one seeds the whole library through the
worker, then each create, update, delete, or restore queues a job. `backup.rs`
reads a committed snapshot, writes the changed bodies and attachments, removes
deleted copies, then updates the active library index. It collapses a burst of saves into one write per
document and records the last failure per connector for the page to show.
Failed batches keep their document IDs in `backup-retries.json` beside the
settings. The next document change retries each affected connector from the
current store state, including after a restart. Copies run off the request path,
so a slow share cannot slow a save. On shutdown `BackupMirror::flush` gives
queued copies a few seconds. Removing a connector stops mirroring and leaves
the files already there alone.

SSH connectors go through `sftp.rs`: Grapho runs the system OpenSSH `sftp` client
in batch mode. Nothing links an SSH
library, and no password or key material is stored; the client uses the user's key
file, agent, and known_hosts, with `BatchMode=yes` and
`StrictHostKeyChecking=accept-new`. The process runs in a staging folder, so
batch commands only need bare local file names. Each batch lists the remote
files before copying so it can remove old attachments. Adding an SSH connector
lists the remote folder first (which
proves the host, the account, and the path, and refuses another library's
documents), then seeds; the connector is remembered only if both work.

Google Drive connectors are native (`drive.rs`). The user creates a Desktop-app
OAuth client in their own Google Cloud project — Grapho cannot ship a client id
for every installation — and pastes its id and secret into the page. The browser
is sent to Google with a PKCE challenge and the `drive.file` scope, and Google
redirects back to the public `/oauth/google/callback`, which exchanges the code
for an access token and a refresh token. Only the refresh token and client secret
are kept, in `secrets.rs`'s file beside the settings; never in `config.json`, never
in the data folder. Each batch lists the Drive folder once (that is also how file
ids are found, so no local id map is needed), then uploads with resumable
requests through `ureq`. The folder is found by name or created; a folder holding
another library's documents is refused.

`build.rs` records `GRAPHO_TAG`, `GRAPHO_COMMIT`, and `GRAPHO_COMMIT_DATE` when
the build has a `.git` directory. `/version` renders them into
`assets/version.html`; a build without git, such as the container image from a
copied source tree, reports "unknown" and "not a tagged build" instead.

The version page also asks GitHub for the latest release, so it is the one
response whose CSP allows `connect-src https://api.github.com`; every other
response keeps `connect-src 'self'`. The request happens once, when the page is
opened, and never in the background: if it fails, is rate limited, or the
browser has no network, the page says so and nothing else changes.

## Library

The home page shows documents as rows or as grid cards. A grid card leads with a
miniature of the document's beginning. The miniature is not an image and is not
stored: `store.rs`'s `preview_html` derives it from the in-memory HTML when the
library is listed, so editing never renders or saves a thumbnail, and every old
document has one before it is ever opened. It keeps the block tags and inline
marks, drops attributes, links, and images (an image becomes a neutral block, so
a card never carries megabytes of base64), and stops after about one page of
text. The card uses the editor's proportions and is sized with container units,
so ordinary browser text wrapping paints the miniature; a soft fade at the
bottom stands in for the page break Grapho does not have. `home.js` fills a
card's preview only when the card comes near the viewport and keeps card
elements between renders. List rows show no miniature.

Library search sends one debounced request to `/api/documents/search?q=…`
and cancels stale requests. The server scans titles and the full plain text
of the current in-memory documents for a case-insensitive phrase, treating runs
of whitespace as a space. It uses the same HTML text extraction as the listing
and ignores markup and image data. Results carry the usual card summary and
plain-text excerpts split around the matching title or passage. The browser
highlights the match in either view, keeps the selected sort, and refreshes
active results after a rename, duplicate, or delete. Clearing the query returns
to the already loaded listing. Search results carry the library query in their
links. A body match opens at the first occurrence in the current document and
briefly highlights the matching text with the editor's selection geometry.
The highlight is independent of the editing selection. Library returns to the
query and brings the originating result into view.

Each card's ⋯ menu opens the document, renames it, duplicates it, or deletes it.
A duplicate is made by the server, not by replaying the document through the
browser: `POST /api/documents/{id}/duplicate` copies the body and paper
width into a new file with its own id and timestamps, then answers with the same
summary the listing carries, so `home.js` adds a card with no listing reload.
The copy's title is its source's name plus ` (copy)`, numbered when a title is
already taken, and the title limit still applies. The source is never touched.

Deleting sets `deleted_at` through the ordinary atomic document write. The
original id, writing, and timestamps stay in the data folder and move with it.
Deleted documents stay out of the library, search, editor, and mirrors. The
library menu opens Recently deleted, which loads a title and deletion date
for each deleted document on demand. Restoring clears the timestamp and queues
the original document for mirroring again. Grapho keeps deleted documents until
they are restored, and Storage includes their bytes in space used.

While the listing is in flight the home page shows placeholder rows or cards.
`index.html` ships a few so the very first paint is not an empty library;
`home.js` then rebuilds the set to cover the first screen in the current view
(one placeholder per list row, one per grid cell), so a slow listing looks like
a page that is loading rather than one with almost nothing on it. The
placeholders are `aria-hidden` and the listing container carries `aria-busy`;
they stay in the DOM through a failed load so "Try again" has something to show
while it waits, and `renderDocuments` does nothing until the first listing has
arrived, so changing the view or the sort during the wait cannot flash the
empty state. The shimmer in `app.css` is the loading cue; it is turned off when
the reader asks for reduced motion.

The Shortcuts page (`/shortcuts`, `assets/shortcuts.html`) is a plain page with
two sections: the editor's keys and the rest of the app's. It has no script of
its own; `menu.js` and `app.css` do the work. The home, editor, and page menus
link to it, so update it when a key handler changes.

Every page except the password gate loads `assets/quick-open.js`. `Ctrl+O` opens
the Open by title palette near the top of the viewport. Results expand below
the search field and scroll when space runs out. The script reads `/api/documents`
when the palette opens, so there is no background refresh and no request per
keystroke, and it filters titles locally. Enter opens the highlighted document,
Shift+Enter opens it in a new tab and switches there, and Escape or a backdrop
click closes the palette. The new-tab action follows a hidden
`target="_blank"` link rather than calling `window.open`, because browsers may
route a scripted window to a separate window; the browser's own link preference
still decides between a tab and a window. The keyboard hints in the footer fade
away after three seconds without moving the footer, and the next opening brings
them back. The listing can answer 401 on the public version and not-found
pages, so that case becomes a sign-in row instead of an error. The palette
builds its own `<dialog>` on first use and `app.css` owns its look; a new page
loads the script with `defer` unless it is the password gate.

## Editor architecture

New Document opens a draft with its own URL. The first save creates the file
only once the title differs from the default or the body has content. A retry
uses the same id, and a successful save switches the draft to its document URL.

The editor does not use `contenteditable`. `assets/doc/input.js` owns the block
model and the selection, `layout.js` turns blocks into positioned lines with
pretext, and `view.js` paints those lines plus the caret and selection.
`model.js` converts the block model to and from the HTML used by the API.

The paper is blank until the editor has fetched, measured, and laid out the
document, and a large document, a slow connection, or a slow machine can make
that last long enough to read as an empty page. `editor.html` therefore carries
a `.paper-loading` ghost of a title and a page of text lines inside the sheet:
it shows only while the paper has `aria-busy="true"`, and `applyDocument` clears
that attribute in the same task that paints the text, so the ghost never
outlives the document. It stays invisible for 150ms before fading in, so an
ordinary fast open shows nothing; reduced motion keeps the delay and drops the
fade. The shimmer is the same library loading cue, and the title and prose are
hidden while the ghost stands in.

- Every line comes from `prepare`/`layoutNextLineRange` or
  `prepareRichInline`/`layoutNextRichInlineLineRange`. Do not reintroduce browser
  text wrapping inside the document.
- Typography lives twice: the font, size, line-height, and letter-spacing
  constants in `layout.js` are what pretext measures, and the matching
  `.doc-line` classes in `app.css` paint them. The Canvas font stacks include
  the same fallbacks as `--font-reading` and `--font-mono`. Change both sides
  together, or carets and selections drift.
- Images are blocks. `mode: "left" | "right"` floats one over the following lines
  by narrowing them; `mode: "block"` centres it with its own vertical space;
  `mode: "free"` places it at `x` (from the column's left) and `y` (from the top
  of the document's content), stored as `class="free" data-x data-y`. Lines that
  meet an image narrow to its emptier side, clear it when neither side is usable,
  and clear all images that meet a line at once. Code blocks wrap their lines the
  same way. If several wrapped images keep moving each other's anchors, the last
  pass pins them in place, so no line can end up beneath an image.
- The image menu opens from the picture's context menu (a right click, or a long
  press on touch) and selects the image it acts on. A plain click only selects
  the picture, which keeps dragging, resizing, and the arrow keys working.
- Dragging writes the new absolute position directly; holding Shift on the press
  or during the drag locks the move to one axis, chosen from the direction the
  pointer moved further on when Shift went down, and arrow keys move a selected
  image by 4 px (24 with Shift). A Shift press that never moves still extends the
  text selection to the image. A selected image shows four corner handles;
  dragging one keeps the opposite corner fixed, preserves the aspect ratio, and
  stores the rendered width as `data-width` (the natural `width`/`height` stay).
  Holding Alt scales around the image's centre instead. Resizing turns the image
  free, so the text reflows beside it.
- Rotating and flipping are bitmap edits, not stored transforms: the three
  buttons in the image menu rewrite the embedded data URL through
  `assets/doc/image.js` and hand the block its new natural `width`/`height`. A
  turn swaps the block's stored `data-width` for the height it was rendered at,
  so the picture keeps the scale it was resized to; `transformImage` reports
  `turned` so the caller knows when to do that. A flip keeps the natural size
  and the stored `data-width` untouched, so a mirrored picture never resizes.
  Every other reader of the document (view, layout, PDF, HTML export) therefore
  needs no transform of its own, and the menu stays open because one turn is
  rarely the whole gesture. Undo restores the previous data URL.
- `Download image` writes the embedded data URL's own bytes back out as a file,
  never a re-render or re-encode of the picture on the page. The name comes from
  the image's alt text, which starts as the inserted file's name, and falls back
  to the document title; the blob goes through the same download helper as the
  exports. The menu closes like it does for the other whole-image actions.
- A corner radius is the opposite: a bounded `data-radius` on the `<img>`, not
  pixels. Images are square by default (`IMAGE_RADIUS_DEFAULT`), so only a
  different value is stored; the menu field applies it on `input` with coalesced
  undo, and `imageRadius()` clamps it. The view paints it as `border-radius`, the
  PDF export clips the image with a rounded path, and the HTML export writes one
  `img[data-radius="N"]` rule per radius the document uses, since it cannot put
  an inline style on an image.
- The image menu's placement row sets the three modes directly: the left and
  right icons are the old `Wrap left`/`Wrap right` items, and the middle one
  turns the picture into a block image with `data-width` pinned to the width it
  already had, so it returns to the middle without being resized. `Block` stays
  for a block image at its natural width, and a free image keeps the position it
  was dropped at until one of the three is chosen.
- A divider is a block represented by `<hr>` in HTML and `---` on disk. `layout.js` gives it an
  18 px band with space above and below and `dividerLineY` says where the rule
  goes, so `view.js` and `pdf.js` paint the same line. It has no text: like a
  picture, a click selects it, Backspace or Delete removes it, typing over it
  replaces it with a paragraph, Enter opens a paragraph after it, and the arrow
  keys step over it. A selection that reaches one paints its band. The `--- `
  shortcut creates one, the HTML export styles the `hr`, and in Markdown mode it
  is the source line `---` (see the dialect below).
- Paragraph alignment is a block property stored as `data-align` on the block tag
  (or list item). Layout shifts each painted line for centre/right alignment and
  stretches spaces on justified lines except the last line of a segment. Older
  documents can still carry the bounded `data-indent` block property (24 px per
  step); it is parsed, laid out, exported, and sanitized as before, but the
  editor no longer creates one, and `Shift+Tab` only takes a step off it on an
  ordinary paragraph line that has no text indentation to remove (a legacy
  indent on a list item is left alone). Lists keep `depth` for nesting.
  `Tab` types four spaces at the caret, nests a list item, and inserts a tab in
  a code block. A selection gets one tab stop at the start of every line it
  touches, the way a code editor indents a block of text: four spaces in a
  paragraph (one per hard-break line), a tab in a code block, and a nesting
  level for a list item. `Shift+Tab` removes one tab stop from every selected
  line, takes back a tab typed immediately before the caret, or outdents a
  list; it never deletes the selected text. A selection that ends exactly at
  the start of a line leaves that line alone. The Align popover sets only
  alignment. Code blocks and images are outside paragraph alignment.
- Enter inside a heading ends the heading: the text before the break keeps its
  heading style, and the line the caret lands on is an ordinary paragraph, so
  writing a title continues in Normal text instead of another heading. Enter at
  the very start of a heading does not break it: it opens an ordinary empty line
  above, so the heading can be moved down whole. `Shift+Enter` is still a hard
  break inside the heading. This is rich-text behavior only; Markdown source
  lines are plain blocks and keep their markers.
- Markdown line shortcuts work in the rendered editor: typing `- ` at the start
  of a block starts a bullet item, `# `, `## `, or `### ` starts Heading 1 to 3,
  and `--- ` turns the block into a divider and opens a paragraph below it. The
  space that completes the marker triggers the rule and both it and the marker
  are consumed, so the caret continues in the new style and text after it stays
  in the converted block (a divider takes the whole line, so that text continues
  in the paragraph beneath it). The rules run on typed input only and only at the
  very start of a line: a marker elsewhere, a code block, pasted text, and
  Markdown source keep the literal characters.
- The library metadata index stores each document's `paper_width` in pixels.
  The editor applies it before the first layout. Dragging either border
  resizes both edges around the centre; the workspace bounds the drag and leaves
  a small gap at the edge of the screen. Widths near the 900 px default snap back
  to it with a short magnetic hold and an accent grip line; the snap drops the
  stored preference so the page follows the stylesheet again. Touch-only screens
  hide the grips.
- Edits go through `DocEditor.commit()`, which snapshots undo state, re-lays out,
  and repaints. Do not mutate `blocks` in place.
- A soft wrap shares one offset between the end of a line and the start of the
  next. `lineHint` records which side a click or a vertical move chose; commits
  clear it, so typing a space at the wrap keeps the caret on the line above.
- A code line carries a synthetic fragment and its own offset range, so the same
  caret, click, and selection code works in `<pre>` blocks. Trailing spaces at a
  line end are painted for the caret but left out of alignment, as the browser
  hangs them. Rich text uses `<br>` for hard breaks. Code blocks keep literal
  newlines, with the first one wrapped in a `<span>` when it begins the block
  so HTML parsers preserve it through saving, loading, and pasting.
- The hidden `<textarea>` only captures keystrokes, IME, and clipboard events; its
  value is cleared after every event.
- A modal dialog that closes has to leave the editor able to take typing again.
  Chrome restores focus when a dialog closes without restoring the editing state,
  and can drop focus on the page body instead, so keys arrive and nothing is
  written until the page is reloaded. `DocEditor.focusEditor` nudge-blurs an
  already-active textarea for that reason, and both dialogs' `close` events call
  `restoreEditorFocus`, which takes focus back one task later from the page body
  or from that textarea, and from nowhere else. `test/app-check.mjs` checks
  typing after each way out of both dialogs with real key events, because
  `Input.insertText` bypasses the browser path that breaks.
- Copy writes the selection's plain text plus the selected blocks as semantic
  HTML; cut writes the same and then deletes. Paste prefers the HTML flavor and
  reduces it in `assets/doc/clipboard.js` to what the editor can represent:
  headings, paragraphs, lists, quotes, code blocks, inline marks, links, and
  embedded bitmap images. Inline styles other editors use for bold, italic,
  underline, strike-through, and alignment become the same semantic marks and
  bounded `data-align`; scripts, styles, forms, media, remote images, unknown
  attributes, and unsafe URL schemes are dropped before parsing, and paste
  never fetches anything. A `<br>` that sits between block elements is treated
  as another editor's paragraph separator, not as a hard break inside a line.
  A pasted plain paragraph joins the line at the caret run by run, while a
  heading, list, quote, or code block is inserted as its own block and splits
  the line there. A code block takes the pasted text as plain lines, and
  Markdown mode pastes and copies plain text only.
- Page Up and Page Down move the caret one screen and scroll the page by the same
  distance, so the caret keeps its place and the next keystroke stays there. When
  the jump would pass the document, the caret goes to its very first or very last
  character and the paper scrolls to its edge, matching what a native text field
  does. `Ctrl+Home`/`Ctrl+End` always go to those edges, and Shift extends. The
  keys are handled by the editor because the focused textarea would otherwise
  scroll the page and leave the caret behind. The jump is measured from
  `window.innerHeight` minus the caret margin in `view.js`.
- The caret slides to a new position over 80 ms when a cursor gesture places it
  (keys, clicks, drags): `app.css` transitions `left` and `top`, and
  `view.js`'s `setCaret` pins `transition-property: none` for moves that must
  land immediately. Typing, undo/redo, relayout, and the viewport jumps above
  reach `sync()` without `animateCaret`, so they snap; the next gesture restores
  the slide. `prefers-reduced-motion` removes it. A selection hides the caret,
  so collapsing one shows it at the new spot without a slide.
- Double-click selects the word under the pointer. A third click in the same
  gesture selects the writer's line instead, the way a native text field does:
  the text between hard breaks (the whole block when it has none), including the
  hard break after it, so typing over the selection replaces the line instead of
  leaving an empty one. The line is selected whole even when it wraps on the
  paper. A fourth quick click selects the whole document, the same as `Ctrl+A`;
  a picture has no line, so the third click leaves its selection alone.
- Focus mode hides the editor's bar and asks the browser for fullscreen, from
  the document menu (or `Ctrl+Shift+F`). The header stays in the DOM because its
  menu button is the way out: CSS takes it out of the flow, hides the start and
  the toolbar, and lets the paper fill the viewport. Leaving fullscreen leaves
  focus mode, and Escape leaves both.
- Markdown mode, the next item in the document menu (or `Ctrl+Shift+M`), turns
  the paper into editable Markdown source without adding a second editing
  surface. It is a view over the stored document: while it is on the editor
  holds one paragraph block per source line (blocks carry `source: true`, one
  unmarked run, painted by the source style in `layout.js` and
  `.doc-line.is-source`), with image blocks unchanged between the lines.
  Entering converts rich blocks to source. Leaving, saving, and exporting parse
  edited source with `assets/doc/markdown.js`. The editor sends sanitized HTML
  through the JSON API, and the server writes portable Markdown to disk.
  The editing dialect is line-per-block: one line is one
  paragraph, a blank line is an empty paragraph (so intentional line breaks
  survive leaving and re-entering the mode), `#`..`###`, `>`, list markers,
  `---` (a divider) and fences are understood, and inline marks, links,
  underline and hard breaks are inline Markdown. Content Markdown cannot express (alignment, legacy indent,
  empty paragraphs) rides a documented serialized-HTML escape hatch; images stay
  real image blocks and are never written into the source as base64 or urls, and
  only the accepted HTML shapes are parsed, so a stored document still cannot
  reach the network. Both modes offer Heading 1 to 3, and nothing above three:
  the sanitizer turns an older document's `h4` into an `h3`. Toolbar actions in
  the mode edit the source text directly
  through `assets/doc/markdown-edit.js`; `DocEditor.setSourceMode` gates the
  rich commands off so they can never rewrite a source line as a styled block.
  The mode is per-visit (off after a reload) and is never stored with the
  document. The mode keeps the rich blocks and undo and redo stacks in a
  snapshot. An unchanged round trip restores them exactly. Markdown edits have
  their own undo steps while in source mode and become a single rich-text undo
  step on exit when the parsed document changed.
- The link dialog (`Ctrl+K`) opens at a caret or with text selected. At a bare
  caret it inserts the chosen document title, heading, or typed web address as
  the link label. Selected text and existing link labels keep their wording.
  The list shows recent documents, filters by title as the writer types,
  and links the chosen page as a root-relative
  `/doc/<id>`. Clicking a document row or pressing Enter links the page. Its
  right arrow (or Right on the selected result) loads that document on demand
  and lists its headings in order, using the same anchors as the editor.
  Choosing a heading adds its fragment to the link. Left or Escape returns to
  the document results and restores the search position. The listing is read once
  when the dialog opens, like `Ctrl+O`, and filtered locally, so typing sends no
  request; the current document is left out. A root-relative target keeps
  working on any host or port the library is served from, the store's sanitizer
  passes it, and Markdown mode carries it.
- Clicking or tapping a rich-text link opens its destination, Open, and Edit
  controls. The toolbar link button also offers them at a linked caret.
  The popover reads a Grapho page's title on demand from its protected
  `/api/documents/{id}/title` route. Open follows a Grapho page in the same
  tab after flushing pending edits. Back restores the reading position after
  layout using the source history entry. External web links and Ctrl+click
  open in a new tab.
- Heading anchors are derived, never stored: `model.js`'s `headingAnchors` slugs
  each heading's text (accents folded, lowercase, punctuation and whitespace runs
  to one hyphen, capped at 80 characters), gives repeats "-2", "-3" suffixes in
  document order, and calls a heading with no letters "section". Right-clicking
  a heading or using the keyboard's context menu from a heading offers
  "Copy link to heading". If the word has spelling suggestions, the copy action
  appears alongside them. It copies the absolute `/doc/<id>#<anchor>` URL.
  On a plain-http origin, where the Clipboard API is unavailable, the old
  selection-and-copy path is the fallback.
  Opening such a link scrolls the heading below the sticky header and puts the
  caret in it, and a `hashchange` repeats the jump smoothly. The link dialog
  accepts and stores root-relative targets with a fragment. Anchors are absent
  from Markdown mode (its blocks are source lines, not headings), and neither the
  exported HTML nor the PDF carries them yet: that is the hook a TOC and export
  anchors would use.
- Spellcheck checks rich-text prose in US English. The document menu and
  Ctrl+Alt+S toggle it for the browser. The title uses native textarea
  spellcheck. The rich-text checker runs in a same-origin worker and loads the
  embedded dictionary only after there is text to check. After a pause in
  typing, it checks new or changed blocks and drops results for replaced blocks.
  The view paints spelling marks
  from the selection geometry. Right-click, tap, or Shift+F10 at a marked word
  opens suggestions. Corrections preserve inline formatting and use ordinary
  undo. Add to dictionary saves a word in `spelling-words.json` in the data
  folder through the protected `/api/spelling/words` endpoint. The editor
  loads custom words when starting spellcheck and accepts them across documents
  and browsers. Code, URLs, and Markdown source are skipped. Assets under
  `assets/spellcheck/` include the original licenses
  for Typo.js (BSD-3-Clause) and the SCOWL en_US dictionary (2020.12.07).
- Known gaps: screen readers get the painted text but not a
  text-editing surface, printing the editor prints the painted page, image and
  paper resizing need a pointer, turning an animated GIF keeps only its first
  frame, and HTML or Markdown exports put free-positioned images back into the
  text flow. Markdown mode is a view, not a Markdown file: its lines are one
  paragraph each (a blank line is an empty paragraph, not Markdown's paragraph
  grouping), and alignment, indentation, underline, hard breaks and empty
  paragraphs show up in the source as small HTML snippets when they carry
  attributes Markdown cannot express.
  Its link dialog creates http, https, mailto, and root-relative Grapho page
  links; other relative and fragment links already stored in a document
  round-trip unchanged. An inline toolbar toggle does nothing (rather than
  nesting markers) when the caret sits inside an existing emphasis or code span.
- PDF export (`assets/doc/pdf.js`) lays the document out again at an A4 content
  width, so its line breaks can differ from the paper on screen. It writes the
  file itself and uses the standard PDF fonts (Times and Courier), so do not add
  a PDF library or embed fonts. Fragment widths come from the layout and become
  PDF horizontal scaling, which keeps lines aligned without Literata. Only
  WinAnsi characters survive; anything else becomes `?`.

## Invariants

These should not be casually changed:

- The store sanitizes both incoming API HTML and HTML rendered from disk.
  The allowlist in `store.rs` is the trust boundary.
- The API carries images as bitmap data URLs. The store writes their bytes
  to local attachments and uses relative paths in Markdown. Opening a document
  resolves only its own attachments.
- Markdown mode is an editing view. Saving and exporting go through
  `documentBlocks()`, which parses the source back
  before the payload is built; source lines never contain images, and the
  source parser only accepts the documented HTML escape shapes (no `img`, no
  remote URLs), so a document still cannot make the browser fetch anything. The
  mode is per-visit and is never written into a document.
- Formatting uses semantic tags in the API and Markdown on disk. Bounded
  `data-align` and `data-indent` use safe HTML in Markdown. The index carries
  the bounded image attributes. The sanitizer validates both, and CSP forbids
  inline styles.
- `parseDocument` and `serializeDocument` round-trip the API HTML.
  `src/markdown.rs` round-trips that content through the data folder.
- Clipboard HTML is untrusted input. Copy writes semantic HTML; paste reduces it
  in `assets/doc/clipboard.js` to the tags and bounded attributes the editor can
  write, plus the inline styles other editors use for bold, italic, underline,
  strike-through, and alignment, which become the same semantic model. Scripts,
  styles, forms, media, remote images, unsafe URL schemes, and unknown attributes
  are dropped before parsing. Paste must never touch the network, and every
  pasted document still has to pass the store sanitizer unchanged.
- The CSP, frame denial, no-referrer policy, and same-origin mutation check are
  part of the app. Do not loosen them for convenience. The version page is the
  only response allowed `connect-src https://api.github.com`, for its update
  check; nothing else may reach an outside origin.
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
  `/api/health`, `/version`, `/oauth/google/callback`, and `/assets/*`; a new
  public route needs a reason. The Google callback is public because a
  `SameSite=Strict` cookie is not sent on a redirect from accounts.google.com;
  its single-use `state` value is the credential.
- Argon2 runs on a blocking thread behind a single permit, failed logins are
  throttled per client address, and authenticated responses are `no-store` with
  `Vary: Cookie`. Keep all three when touching the login code. The pause is
  checked, the password verified, and the failure recorded under that one permit,
  so a burst of concurrent attempts cannot outrun the window; an earlier check may
  answer a paused client sooner, but must never let anything be verified. The
  address is the connection's peer, never `X-Forwarded-For`, which a client can
  write with a new value on every guess; the router is therefore served with
  connect info. Pauses are per address so one client cannot lock out the owner,
  which means a distributed attacker, or one presenting many IPv6 addresses, is
  bounded per address rather than overall: that is why the 12-character minimum
  stays. The address table is capped, so a
  server reachable from many addresses cannot grow it without bound. Sessions and
  the failure counter are in memory on purpose: a restart signs everyone out and
  clears a login pause.
- Login redirects carry the destination in `next` as one encoded query value. The
  browser only follows it when it is a path on this server (`/login.js`
  `nextPath()`); do not turn it into an open redirect.
- Writes go through the temporary-file-and-replace path in `store.rs`. Do not
  introduce a database or write directly to a live document file.
- The data folder is chosen by the rules in `settings.rs`: `GRAPHO_DATA_DIR`
  first, then the folder saved on the Storage page, then `./data` when it holds
  documents, then the per-user default. The Storage page must not overrule the
  environment.
- Changing the main folder copies the documents stored there before the switch
  and leaves the previous folder's files in place. A target can be empty or hold
  the store's own copies, which makes choosing the previous folder again work.
- `/storage` and its API routes stay on the protected router because they reveal
  filesystem paths and change where documents are written. The settings file is
  written outside the data directory it describes.
- Free space is best effort (`disk.rs`). When the platform or the folder cannot
  answer, hide the numbers instead of guessing or failing the page.
- Backup copies go through the worker in `backup.rs`, never through a request
  handler. A save must be acknowledged after the primary folder's write, no
  matter how slow a connector is.
- Removing a backup connector never deletes the copies already in its folder. A
  failed copy is shown on the Storage page and retried on the next save, never by
  a timer or polling loop.
- A backup folder must not overlap the data folder, be a connector already, or
  hold documents from another library; the same "refuse, do not merge" rule as
  moving the data folder applies.
- The settings file holds `data_dir` and `backups`. Every write is a
  read-modify-write under the app state's settings lock so two rare actions
  cannot lose each other, and the folder is written outside the data directory.
- SSH backups run the system `sftp` client; do not link an SSH crate. No
  password, private key, or passphrase is ever accepted or stored, and the client
  must stay non-interactive (`BatchMode=yes`) with host keys accepted on first
  use and refused when they change (`StrictHostKeyChecking=accept-new`).
- The sftp script is built only from validated fields. Remote paths reject quotes
  and newlines, host and user are restricted to plain name characters, and local
  files are bare names read from a staging folder, never quoted
  paths with spaces.
- An SSH connector is remembered only after the remote listing and the seed both
  succeed; a failed add leaves no connector and no inherited key material behind.
- Google Drive uses the OAuth client the user creates in their own Cloud project,
  and only the `drive.file` scope. Never request full Drive access, and never ship
  a client id as if it belonged to the installation.
- The OAuth client secret and refresh token live only in `secrets.json` beside the
  settings file (owner-only where the platform allows), never in `config.json`,
  never in the data folder, and never in a document. Removing the connector
  deletes them.
- The OAuth start route requires a loopback `Host` (Google only redirects to a
  loopback IP literal), and the callback is public, single-use, and bounded to ten
  minutes by its `state` value. Do not add a second public route for this flow.
- Drive calls run on a blocking thread off the request path and report their
  failure; a failed copy is retried by the next save, never by a timer or a
  polling loop, and the browser never talks to Google for a backup.

## Releases

A pushed `v<version>` tag runs `.github/workflows/release.yml`. The tag must
match `Cargo.toml`. The workflow builds Linux, macOS, and Windows binaries,
adds `.deb`/`.rpm` packages, and writes `SHA256SUMS.txt`. After publishing it
also refreshes the apt repository and the container image through the reusable
workflows in `.github/workflows/`.

The `cross` job adds armv7 Linux, riscv64 Linux, and x86_64 FreeBSD builds using
a pinned build of cross-rs. Those cross-compiled binaries are not executed in CI.
FreeBSD uses Rust 1.89 because its cross image is Ubuntu 20.04 with glibc 2.31,
which cannot run build scripts from newer toolchains.

riscv64 needs `-C target-feature=+crt-static`: `riscv64gc-unknown-linux-musl` is
the only musl target whose prebuilt standard library is built for dynamic linking
(`rustc --print cfg` reports no `crt-static` feature for it), so without the flag
its binary fails the static check the other musl builds pass. `release.yml` sets
`CARGO_TARGET_RISCV64GC_UNKNOWN_LINUX_MUSL_RUSTFLAGS` for that one matrix entry;
a build of it was run under qemu-riscv64 to confirm it starts and serves
`/api/health`.

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
- `.github/workflows/apt.yml` builds the apt repository from a release's `.deb`
  files and deploys it to GitHub Pages, which must be enabled with "GitHub
  Actions" as the source. `release.yml` calls it after publishing, and
  `workflow_dispatch` backfills a tag. It signs `InRelease` with the same
  `GPG_PRIVATE_KEY` as the release, indexes with `dpkg-scanpackages` and
  `apt-ftparchive`, and serves `packaging/apt/index.html` as the landing page.
  The published source is `https://igor-couto.github.io/grapho stable main`.
- `packaging/aur/` holds the AUR recipe for the prebuilt binaries, published as
  `grapho-bin`; pacman installs the package that `makepkg` builds from it, and
  the AUR hosts no binaries itself. `PKGBUILD` and `.SRCINFO` must stay in step:
  after any change, regenerate `.SRCINFO` with `makepkg --printsrcinfo`. Both
  `sha256sums_*` entries must match that release's Linux tarballs, and the
  `package()` paths depend on the tarball's `grapho-<version>-linux-<arch>`
  folder name.
- `.github/workflows/image.yml` publishes `ghcr.io/igor-couto/grapho` with
  `linux/amd64`, `linux/arm64`, and `linux/arm/v7` manifests merged into one tag
  per release, plus `latest` for tags without a prerelease suffix. Each image is
  assembled from the release's static binary using
  `packaging/docker/Dockerfile`, so there is no compilation and no emulation.
  The GHCR package is private after the first push and has to be made public
  once in its package settings.

The Windows builds link the C runtime statically (`RUSTFLAGS:
-C target-feature=+crt-static` in `release.yml`), so the binary imports only
DLLs that Windows itself ships and no VC++ redistributable is needed. CI
compiles Windows with the same flag, so a broken static link fails on a pull
request instead of on a release tag. To check a release, list the binary's
imports: `VCRUNTIME140.dll` must not appear. The 0.1.0 Windows binaries predate
this and did need the redistributable.

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
`node --check assets/login.js`, `node --check assets/menu.js`,
`node --check assets/quick-open.js`, `node --check assets/storage.js`, and
`node --check assets/theme.js` are useful syntax checks when Node is available;
Node is not a runtime dependency.

The editor's caret, selection, and writing behavior is checked in a real
browser. These tests need Node 22+ and a local Chrome or Chromium, but no npm
packages:

```bash
node --test test/editing-regressions.mjs "test/*.test.mjs"  # writing, selection, Unicode, undo and redo
node test/run.mjs          # editor geometry, typing, Markdown source, undo, PDF
node test/app-check.mjs    # real server: sanitizer, save, mouse, reload
```

`test/app-check.mjs` uses the debug binary; run `cargo build` first. Both
scripts find Chrome themselves and accept `CHROME_PATH` (and `GRAPHO_BIN`) when
needed. `node test/run.mjs --screenshot` writes `test/artifacts/editor.png`,
which is ignored.

For UI changes, start the app and check the real browser flow at least once:

1. Create a document, type, wait for "Saved", reload, and confirm the content.
2. Go back to the library and confirm search, rename, and delete still work.
3. Export HTML and PDF and check that the title and body are present.
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
