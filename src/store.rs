use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use ammonia::Builder;
use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use uuid::Uuid;

const SCHEMA_VERSION: u32 = 1;
const MAX_TITLE_CHARS: usize = 200;
const EXCERPT_CHARS: usize = 220;
/// How much text the home page's grid card miniature holds. The card renders
/// this as roughly one page at thumbnail size and clips anything past it, so
/// collecting more would only make the library listing heavier.
const PREVIEW_TEXT_CHARS: usize = 1800;
/// A preview never reads past this point in a document. A document that opens
/// with a large embedded image would otherwise make every library listing read
/// the whole image before reaching the first paragraph.
const PREVIEW_SCAN_BYTES: usize = 64 * 1024;
/// A document's paper width is a display preference, kept in the document file
/// so it survives reloads. These bounds keep a hand-edited file sane.
const MIN_PAPER_WIDTH: u32 = 320;
const MAX_PAPER_WIDTH: u32 = 4000;

/// The on-disk representation of a document.
///
/// Documents are deliberately stored as readable JSON files, one per document,
/// so that a personal library can be backed up or inspected with ordinary
/// tools.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Document {
    #[serde(default = "schema_version")]
    pub version: u32,
    pub id: Uuid,
    pub title: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper_width: Option<u32>,
    pub created_at: u64,
    pub updated_at: u64,
}

/// The compact shape used by the home page.
#[derive(Clone, Debug, Serialize)]
pub struct DocumentSummary {
    pub id: Uuid,
    pub title: String,
    pub excerpt: String,
    pub preview: String,
    pub word_count: usize,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Debug)]
pub enum StoreError {
    Io(io::Error),
    Corrupt { path: PathBuf, message: String },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "{error}"),
            Self::Corrupt { path, message } => {
                write!(f, "{}: {message}", path.display())
            }
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Corrupt { .. } => None,
        }
    }
}

impl From<io::Error> for StoreError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

/// How large the library is on disk.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub documents: usize,
    pub bytes: u64,
}

/// The result of moving the library to another folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Relocated {
    pub directory: PathBuf,
    pub documents: usize,
}

/// Why a new data folder was refused. The HTTP layer turns these into messages
/// a person can act on.
#[derive(Debug)]
pub enum RelocateError {
    NotAbsolute,
    SameDirectory,
    Occupied { documents: usize },
    Io { path: PathBuf, message: String },
}

impl RelocateError {
    fn io(path: &Path, error: impl std::fmt::Display) -> Self {
        Self::Io {
            path: path.to_path_buf(),
            message: error.to_string(),
        }
    }
}

/// A small, file-backed document store.
///
/// The in-memory map is the read path; every mutation is written through to
/// disk before it is acknowledged. This is intentionally simple and plenty for
/// a personal, single-user library, while keeping the data portable.
pub struct Store {
    state: RwLock<State>,
}

/// The folder and the documents it holds move together: relocating has to swap
/// both, and no request may see a half-applied change.
struct State {
    directory: PathBuf,
    documents: HashMap<Uuid, Document>,
}

impl Store {
    pub async fn load(directory: PathBuf) -> Result<Self, StoreError> {
        fs::create_dir_all(&directory).await?;

        let mut documents = HashMap::new();
        let mut entries = fs::read_dir(&directory).await?;

        while let Some(entry) = entries.next_entry().await? {
            let path = entry.path();
            if !entry.file_type().await?.is_file() {
                continue;
            }
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let Ok(id) = Uuid::parse_str(stem) else {
                eprintln!(
                    "ignoring unrecognized file in data directory: {}",
                    path.display()
                );
                continue;
            };

            let bytes = fs::read(&path).await?;
            let mut document: Document =
                serde_json::from_slice(&bytes).map_err(|error| StoreError::Corrupt {
                    path: path.clone(),
                    message: error.to_string(),
                })?;
            if document.id != id {
                return Err(StoreError::Corrupt {
                    path,
                    message: "file name does not match the document id".to_owned(),
                });
            }

            // Files can be edited by hand. Sanitise and normalise them again at
            // the trust boundary so a hand-edited library can never inject
            // markup into the editor.
            document.content = sanitize_content(&document.content);
            document.title = normalize_title(&document.title);
            document.paper_width = document.paper_width.map(bounded_paper_width);

            documents.insert(id, document);
        }

        Ok(Self {
            state: RwLock::new(State {
                directory,
                documents,
            }),
        })
    }

    /// The folder documents are written to right now.
    pub async fn directory(&self) -> PathBuf {
        self.state.read().await.directory.clone()
    }

    /// What the folder holds, counted from the files themselves rather than the
    /// in-memory map, so a hand-edited folder is reported honestly.
    pub async fn usage(&self) -> Usage {
        let directory = self.directory().await;
        scan_usage(&directory).await
    }

    pub async fn list(&self) -> Vec<DocumentSummary> {
        let state = self.state.read().await;
        let mut summaries: Vec<_> = state.documents.values().map(summary_for).collect();
        summaries.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.title.cmp(&right.title))
        });
        summaries
    }

    pub async fn get(&self, id: Uuid) -> Option<Document> {
        self.state.read().await.documents.get(&id).cloned()
    }

    pub async fn create(&self) -> Result<Document, StoreError> {
        let mut state = self.state.write().await;
        let now = now_millis();
        let document = Document {
            version: SCHEMA_VERSION,
            id: Uuid::new_v4(),
            title: "Untitled document".to_owned(),
            content: String::new(),
            paper_width: None,
            created_at: now,
            updated_at: now,
        };

        persist_document(&state.directory, &document).await?;
        state.documents.insert(document.id, document.clone());
        Ok(document)
    }

    /// Apply a partial update. Sanitisation and title normalisation happen here,
    /// at the trust boundary, rather than in the browser.
    pub async fn update(
        &self,
        id: Uuid,
        title: Option<String>,
        content: Option<String>,
        paper_width: Option<u32>,
    ) -> Result<Option<Document>, StoreError> {
        let mut state = self.state.write().await;
        let Some(existing) = state.documents.get(&id).cloned() else {
            return Ok(None);
        };

        let next_title = title
            .map(|value| normalize_title(&value))
            .unwrap_or_else(|| existing.title.clone());
        let next_content = content
            .map(|value| sanitize_content(&value))
            .unwrap_or_else(|| existing.content.clone());
        let next_paper_width = match paper_width {
            // The browser sends zero when the width snaps back to the default,
            // which removes the stored preference instead of pinning a pixel
            // value that should follow the stylesheet.
            Some(0) => None,
            Some(width) => Some(bounded_paper_width(width)),
            None => existing.paper_width,
        };

        if next_title == existing.title
            && next_content == existing.content
            && next_paper_width == existing.paper_width
        {
            return Ok(Some(existing));
        }

        let updated_at = now_millis().max(existing.updated_at.saturating_add(1));
        let document = Document {
            version: SCHEMA_VERSION,
            id,
            title: next_title,
            content: next_content,
            paper_width: next_paper_width,
            created_at: existing.created_at,
            updated_at,
        };

        persist_document(&state.directory, &document).await?;
        state.documents.insert(id, document.clone());
        Ok(Some(document))
    }

    pub async fn delete(&self, id: Uuid) -> Result<bool, StoreError> {
        let mut state = self.state.write().await;
        if !state.documents.contains_key(&id) {
            return Ok(false);
        }

        let path = state.directory.join(format!("{id}.json"));
        match fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(StoreError::Io(error)),
        }

        state.documents.remove(&id);
        Ok(true)
    }

    /// Move the library to another folder.
    ///
    /// Every document is written to the new folder before the store switches to
    /// it, so a failure leaves the current folder exactly as it was. The old
    /// files are never removed: the previous folder stays behind as a copy.
    ///
    /// A folder that only holds copies of these documents is accepted, which is
    /// what makes choosing the previous folder again work. A folder holding any
    /// other document is refused, so two libraries are never silently merged.
    pub async fn relocate(&self, target: PathBuf) -> Result<Relocated, RelocateError> {
        if !target.is_absolute() {
            return Err(RelocateError::NotAbsolute);
        }

        let mut state = self.state.write().await;
        if same_directory(&state.directory, &target) {
            return Err(RelocateError::SameDirectory);
        }

        fs::create_dir_all(&target)
            .await
            .map_err(|error| RelocateError::io(&target, error))?;

        let existing = document_files(&target).await;
        let strangers = existing
            .iter()
            .filter(|(id, _)| !state.documents.contains_key(id))
            .count();
        if strangers > 0 {
            return Err(RelocateError::Occupied {
                documents: strangers,
            });
        }

        let ours: HashSet<Uuid> = existing.iter().map(|(id, _)| *id).collect();

        // Copies this call creates are the only ones a failure may remove; a
        // file that was already there belongs to the folder's previous use.
        let mut created = Vec::new();
        for document in state.documents.values() {
            if let Err(error) = persist_document(&target, document).await {
                remove_copies(&target, &created).await;
                return Err(RelocateError::io(&target, error));
            }
            if !ours.contains(&document.id) {
                created.push(document.id);
            }
        }

        state.directory = target.clone();
        Ok(Relocated {
            directory: target,
            documents: state.documents.len(),
        })
    }
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

/// A document file is a UUID name with a `.json` extension. Anything else in the
/// folder belongs to someone else and is never counted, copied, or removed.
pub(crate) fn document_file_id(path: &Path) -> Option<Uuid> {
    if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
        return None;
    }
    Uuid::parse_str(path.file_stem()?.to_str()?).ok()
}

async fn scan_usage(directory: &Path) -> Usage {
    let files = document_files(directory).await;
    Usage {
        documents: files.len(),
        bytes: files
            .iter()
            .fold(0, |total: u64, (_, bytes)| total.saturating_add(*bytes)),
    }
}

/// Every document file in a folder, with its size. Names that are not UUID
/// document files are ignored, and an unreadable folder simply has none.
pub(crate) async fn document_files(directory: &Path) -> Vec<(Uuid, u64)> {
    let mut files = Vec::new();
    let Ok(mut entries) = fs::read_dir(directory).await else {
        return files;
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let Some(id) = document_file_id(&entry.path()) else {
            continue;
        };
        let Ok(metadata) = entry.metadata().await else {
            continue;
        };
        files.push((id, metadata.len()));
    }

    files
}

/// A typed path and the path the browser showed may differ in separators,
/// trailing slashes, and letter case on Windows.
pub(crate) fn same_directory(left: &Path, right: &Path) -> bool {
    comparable_path(left) == comparable_path(right)
}

fn comparable_path(path: &Path) -> String {
    let mut text = path.to_string_lossy().into_owned();

    while text.len() > 1 && (text.ends_with('/') || text.ends_with('\\')) {
        let trimmed = &text[..text.len() - 1];
        if trimmed.ends_with(':') {
            break;
        }
        text.pop();
    }

    #[cfg(windows)]
    {
        text = text.replace('/', "\\");
        text.make_ascii_lowercase();
    }

    text
}

/// Best effort: the documents that were copied before a failure go away again,
/// so a second attempt does not meet its own leftovers.
async fn remove_copies(directory: &Path, written: &[Uuid]) {
    for id in written {
        let _ = fs::remove_file(directory.join(format!("{id}.json"))).await;
    }
}

fn bounded_paper_width(width: u32) -> u32 {
    width.clamp(MIN_PAPER_WIDTH, MAX_PAPER_WIDTH)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

pub fn normalize_title(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let title = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = title.chars().take(MAX_TITLE_CHARS).collect();
    let title = title.trim().to_owned();

    if title.is_empty() {
        "Untitled document".to_owned()
    } else {
        title
    }
}

/// Only the small, predictable subset of HTML the editor can produce is allowed
/// to survive. This keeps stored documents safe to render, even if a client is
/// modified or a file is edited by hand.
///
/// The editor offers Heading 1 to 3; an older document's `<h4>` is demoted to
/// `<h3>` below, so no deeper level reaches the browser or a new file.
pub fn sanitize_content(html: &str) -> String {
    let tags: HashSet<&str> = [
        "a",
        "b",
        "blockquote",
        "br",
        "code",
        "del",
        "div",
        "em",
        "h1",
        "h2",
        "h3",
        // Not a heading level Grapho offers: `h4` stays in the set only so
        // `demote_heading_four` can see it and turn an older document's fourth
        // level into an `h3` instead of dropping it to a plain paragraph.
        "h4",
        "i",
        "img",
        "li",
        "ol",
        "p",
        "pre",
        "s",
        "span",
        "strike",
        "strong",
        "u",
        "ul",
    ]
    .into_iter()
    .collect();

    let mut link_attributes = HashSet::new();
    link_attributes.insert("href");
    link_attributes.insert("title");

    let mut image_attributes = HashSet::new();
    image_attributes.insert("src");
    image_attributes.insert("alt");
    image_attributes.insert("class");
    image_attributes.insert("width");
    image_attributes.insert("height");
    image_attributes.insert("data-x");
    image_attributes.insert("data-y");
    image_attributes.insert("data-width");
    image_attributes.insert("data-radius");

    let mut block_attributes = HashSet::new();
    block_attributes.insert("data-align");
    block_attributes.insert("data-indent");

    let tag_attributes = HashMap::from([
        ("a", link_attributes),
        ("img", image_attributes),
        ("p", block_attributes.clone()),
        ("div", block_attributes.clone()),
        ("blockquote", block_attributes.clone()),
        ("h1", block_attributes.clone()),
        ("h2", block_attributes.clone()),
        ("h3", block_attributes.clone()),
        // An older document's `h4` keeps its alignment and indent when it is
        // demoted, so it still looks like the heading the author wrote.
        ("h4", block_attributes.clone()),
        ("li", block_attributes),
    ]);

    // `data:` carries embedded image bytes. The attribute filter below keeps it
    // on images and removes it from links, so a stored document can never turn
    // a click into a `data:text/html` page.
    let url_schemes = ["http", "https", "mailto", "data"].into_iter().collect();

    let clean = Builder::default()
        .tags(tags)
        .tag_attributes(tag_attributes)
        .url_schemes(url_schemes)
        .link_rel(Some("noopener noreferrer"))
        .attribute_filter(|element, attribute, value| match (element, attribute) {
            ("img", "src") if !is_embedded_image(value) => None,
            ("img", "class") => {
                let kept: Vec<&str> = value
                    .split_whitespace()
                    .filter(|name| matches!(*name, "wrap-left" | "wrap-right" | "free"))
                    .collect();
                if kept.is_empty() {
                    None
                } else {
                    Some(Cow::Owned(kept.join(" ")))
                }
            }
            ("a", "href") if value.to_ascii_lowercase().starts_with("data:") => None,
            ("p" | "div" | "blockquote" | "h1" | "h2" | "h3" | "h4" | "li", "data-align") => {
                match value {
                    "center" | "right" | "justify" => Some(Cow::Borrowed(value)),
                    _ => None,
                }
            }
            ("p" | "div" | "blockquote" | "h1" | "h2" | "h3" | "h4" | "li", "data-indent") => {
                let level = value.as_bytes().first().copied().unwrap_or_default();
                let numeric = value.len() == 1 && (b'1'..=b'6').contains(&level);
                numeric.then_some(Cow::Borrowed(value))
            }
            ("img", "width") | ("img", "height") => {
                let numeric = !value.is_empty()
                    && value.len() <= 5
                    && value.chars().all(|digit| digit.is_ascii_digit())
                    && value != "0";
                numeric.then_some(Cow::Borrowed(value))
            }
            ("img", "data-x") | ("img", "data-y") => {
                let digits = value.strip_prefix('-').unwrap_or(value);
                let numeric = !digits.is_empty()
                    && digits.len() <= 5
                    && digits.chars().all(|digit| digit.is_ascii_digit());
                numeric.then_some(Cow::Borrowed(value))
            }
            ("img", "data-width") => {
                let numeric = !value.is_empty()
                    && value.len() <= 5
                    && value.chars().all(|digit| digit.is_ascii_digit())
                    && value != "0";
                numeric.then_some(Cow::Borrowed(value))
            }
            ("img", "data-radius") => {
                // Zero means square corners, so unlike `data-width` it is kept.
                // The editor caps the radius at 200 (IMAGE_RADIUS_LIMIT in
                // assets/doc/model.js); anything further is not a value it wrote.
                let canonical = (value == "0" || (value.len() <= 3 && !value.starts_with('0')))
                    && value.chars().all(|digit| digit.is_ascii_digit())
                    && value.parse::<u32>().is_ok_and(|radius| radius <= 200);
                canonical.then_some(Cow::Borrowed(value))
            }
            _ => Some(Cow::Borrowed(value)),
        })
        .clean(html)
        .to_string();

    demote_heading_four(clean)
}

/// Heading levels stop at three. A document written by an older version may
/// still carry `<h4>`; it becomes an `<h3>` so the text keeps its place in the
/// outline instead of turning into a paragraph when the file is next written.
///
/// This runs on the sanitiser's output, where `<` only ever starts a tag, so
/// escaped text like `&lt;h4&gt;` is never touched.
fn demote_heading_four(html: String) -> String {
    if !html.contains("<h4") && !html.contains("</h4") {
        return html;
    }

    let mut output = String::with_capacity(html.len());
    let mut rest = html.as_str();
    loop {
        let opening = rest.find("<h4");
        let closing = rest.find("</h4");
        let Some(start) = (match (opening, closing) {
            (Some(opening), Some(closing)) => Some(opening.min(closing)),
            (opening, closing) => opening.or(closing),
        }) else {
            output.push_str(rest);
            break;
        };

        output.push_str(&rest[..start]);
        let tag = &rest[start..];
        let (length, replacement) = if tag.starts_with("</h4") {
            (4, "</h3")
        } else {
            (3, "<h3")
        };
        let after = &tag[length..];
        let name_ends = after.starts_with('>')
            || after.starts_with('/')
            || after.starts_with(char::is_whitespace);
        if name_ends {
            output.push_str(replacement);
        } else {
            // `<h40` or similar: not the heading element.
            output.push_str(&tag[..length]);
        }
        rest = after;
    }
    output
}

/// Images are stored inline as base64 data URLs. Only the bitmap formats the
/// editor writes are accepted; an SVG data URL is markup and stays out.
fn is_embedded_image(value: &str) -> bool {
    const PREFIXES: [&str; 4] = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
        "data:image/gif;base64,",
    ];
    PREFIXES
        .iter()
        .any(|prefix| value.len() > prefix.len() && value.starts_with(prefix))
}

/// Convert safe stored HTML into text for summaries and word counts.
pub fn html_to_text(html: &str) -> String {
    let mut raw = String::with_capacity(html.len());
    let mut index = 0;

    while index < html.len() {
        let rest = &html[index..];
        let Some(character) = rest.chars().next() else {
            break;
        };

        if character == '<' {
            if let Some(relative_end) = rest.find('>') {
                let tag = rest[1..relative_end].trim().to_ascii_lowercase();
                if is_line_break_tag(&tag) {
                    raw.push('\n');
                }
                index += relative_end + 1;
                continue;
            }
        }

        raw.push(character);
        index += character.len_utf8();
    }

    let decoded = html_escape::decode_html_entities(&raw);
    decoded
        .replace('\u{00a0}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_line_break_tag(tag: &str) -> bool {
    tag == "br"
        || tag == "br/"
        || tag.starts_with("br ")
        || tag.starts_with("img")
        || [
            "/p",
            "/div",
            "/h1",
            "/h2",
            "/h3",
            "/li",
            "/blockquote",
            "/pre",
        ]
        .iter()
        .any(|prefix| tag.starts_with(prefix))
}

fn summary_for(document: &Document) -> DocumentSummary {
    let text = html_to_text(&document.content);
    let mut preview = preview_html(&document.content);
    if preview.is_empty() && !text.is_empty() {
        // The markup started with something larger than the preview's scan
        // window (a document that opens with a big embedded image, say). The
        // text is already here, so the card still shows the writing.
        preview = text_preview(&text);
    }
    DocumentSummary {
        id: document.id,
        title: document.title.clone(),
        excerpt: make_excerpt(&text),
        preview,
        word_count: text.split_whitespace().count(),
        created_at: document.created_at,
        updated_at: document.updated_at,
    }
}

fn make_excerpt(text: &str) -> String {
    let characters: Vec<char> = text.chars().collect();
    if characters.len() <= EXCERPT_CHARS {
        return text.to_owned();
    }

    let candidate: String = characters[..EXCERPT_CHARS - 1].iter().collect();
    let cut = candidate
        .rfind(' ')
        .filter(|index| *index > EXCERPT_CHARS / 2)
        .unwrap_or(candidate.len());

    format!("{}…", candidate[..cut].trim_end())
}

/// The fallback miniature for a document whose markup the preview scan could
/// not get through: the plain text, escaped into one paragraph.
fn text_preview(text: &str) -> String {
    let end = text
        .char_indices()
        .nth(PREVIEW_TEXT_CHARS)
        .map_or(text.len(), |(offset, _)| offset);
    format!("<p>{}</p>", html_escape::encode_text(&text[..end]))
}

/// A miniature of a document's beginning, for the home page's grid cards.
///
/// The preview is derived from the stored HTML on demand rather than rendered
/// and saved like an image: it is cheap because it stops after one page of
/// text, it is never stale, and every document has one before it is opened.
/// Block tags and inline marks survive so the miniature reads like a page;
/// attributes, links, and images do not (an image becomes a neutral block, so
/// a picture never pulls megabytes of base64 into a library listing).
fn preview_html(html: &str) -> String {
    let mut end = html.len().min(PREVIEW_SCAN_BYTES);
    while end < html.len() && !html.is_char_boundary(end) {
        end -= 1;
    }
    let html = &html[..end];

    let mut output = String::with_capacity(2048);
    let mut open: Vec<&'static str> = Vec::new();
    let mut remaining = PREVIEW_TEXT_CHARS;
    let mut index = 0;

    while index < html.len() && remaining > 0 {
        let rest = &html[index..];

        if let Some(tag) = rest.strip_prefix('<') {
            let Some(length) = tag.find('>') else {
                break;
            };
            index += length + 2;
            let body = tag[..length].trim();

            if let Some(closing) = body.strip_prefix('/') {
                close_preview_tag(&mut output, &mut open, closing.trim_start());
            } else {
                match preview_tag_name(body) {
                    "br" => output.push_str("<br>"),
                    "img" => output.push_str("<span class=\"document-thumb-image\"></span>"),
                    name => {
                        if let Some(tag) = preview_tag(name) {
                            output.push('<');
                            output.push_str(tag);
                            output.push('>');
                            open.push(tag);
                        }
                    }
                }
            }
            continue;
        }

        let text_end = rest.find('<').map_or(html.len(), |stop| index + stop);
        let decoded = html_escape::decode_html_entities(&html[index..text_end]);
        index = text_end;

        let mut taken = 0;
        let mut cut = decoded.len();
        for (offset, _) in decoded.char_indices() {
            if taken == remaining {
                cut = offset;
                break;
            }
            taken += 1;
        }

        output.push_str(&html_escape::encode_text(&decoded[..cut]));
        remaining -= taken;
    }

    while let Some(tag) = open.pop() {
        output.push_str("</");
        output.push_str(tag);
        output.push('>');
    }

    output
}

/// The tags a preview keeps, normalised. Inline versus block matters for the
/// miniature: dropping a `<div>` or an `<a>` leaves its children in place.
fn preview_tag(name: &str) -> Option<&'static str> {
    Some(match name {
        "p" | "div" => "p",
        "h1" => "h1",
        "h2" => "h2",
        "h3" => "h3",
        "ul" => "ul",
        "ol" => "ol",
        "li" => "li",
        "blockquote" => "blockquote",
        "pre" => "pre",
        "b" | "strong" => "b",
        "i" | "em" => "i",
        "u" => "u",
        "s" | "strike" | "del" => "s",
        "code" => "code",
        _ => return None,
    })
}

/// The element name at the start of a tag body: `h2 class="x"` is `h2`. The two
/// void tags the preview rewrites are matched case-insensitively; the rest are
/// already lowercased by the sanitiser and by the editor's own serializer.
fn preview_tag_name(body: &str) -> &str {
    let name = body
        .split(|character: char| character.is_whitespace() || character == '/')
        .next()
        .unwrap_or_default();
    if name.eq_ignore_ascii_case("br") {
        "br"
    } else if name.eq_ignore_ascii_case("img") {
        "img"
    } else {
        name
    }
}

fn close_preview_tag(output: &mut String, open: &mut Vec<&'static str>, name: &str) {
    let Some(tag) = preview_tag(name) else {
        return;
    };
    let Some(position) = open.iter().rposition(|open_tag| *open_tag == tag) else {
        return;
    };
    while open.len() > position {
        let open_tag = open.pop().expect("the position was found in the stack");
        output.push_str("</");
        output.push_str(open_tag);
        output.push('>');
    }
}

pub(crate) async fn persist_document(
    directory: &Path,
    document: &Document,
) -> Result<(), StoreError> {
    let bytes = serde_json::to_vec_pretty(document).expect("a document is always serialisable");
    let destination = directory.join(format!("{}.json", document.id));
    let temporary = directory.join(format!(".{}.json.tmp", document.id));

    let mut file = fs::File::create(&temporary).await?;
    file.write_all(&bytes).await?;
    file.sync_all().await?;
    drop(file);

    replace_file(&temporary, &destination).await?;
    Ok(())
}

#[cfg(not(windows))]
pub(crate) async fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination).await
}

/// Windows does not replace an existing file with `rename`. Keep the previous
/// version until the new file is safely in place, then remove the backup.
#[cfg(windows)]
pub(crate) async fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    match fs::rename(source, destination).await {
        Ok(()) => Ok(()),
        Err(first_error) => {
            if !destination.exists() {
                return Err(first_error);
            }

            let backup = destination.with_extension("json.bak");
            let _ = fs::remove_file(&backup).await;
            fs::rename(destination, &backup).await?;

            match fs::rename(source, destination).await {
                Ok(()) => {
                    let _ = fs::remove_file(&backup).await;
                    Ok(())
                }
                Err(error) => {
                    let _ = fs::rename(&backup, destination).await;
                    Err(error)
                }
            }
        }
    }
}

/// Shared handle used by the HTTP layer.
pub type SharedStore = Arc<Store>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_cleaned_and_limited() {
        assert_eq!(normalize_title("  A\n\nquiet\tplace  "), "A quiet place");
        assert_eq!(normalize_title("   "), "Untitled document");

        let long = "é".repeat(MAX_TITLE_CHARS + 20);
        assert_eq!(normalize_title(&long).chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn content_is_sanitised() {
        let dirty = concat!(
            "<p>Hello <strong>world</strong></p>",
            "<script>alert('nope')</script>",
            "<a href=\"javascript:alert(1)\" onclick=\"steal()\">bad</a>",
            "<a href=\"https://example.com\" onclick=\"steal()\">good</a>"
        );
        let clean = sanitize_content(dirty);

        assert!(clean.contains("<strong>world</strong>"));
        assert!(clean.contains("https://example.com"));
        assert!(!clean.contains("script"));
        assert!(!clean.contains("javascript:"));
        assert!(!clean.contains("onclick"));
    }

    #[test]
    fn stored_markup_becomes_readable_text() {
        let text =
            html_to_text("<h1>A title</h1><p>One &amp; two<br>three</p><ul><li>four</li></ul>");
        assert_eq!(text, "A title One & two three four");
        assert_eq!(text.split_whitespace().count(), 7);
    }

    #[test]
    fn images_must_be_embedded_bitmaps() {
        let pixel = "data:image/png;base64,iVBORw0KGgo=";
        let dirty = format!(
            concat!(
                "<p>Before</p>",
                "<p><img src=\"{}\" alt=\"A pixel\" width=\"640\" height=\"480\"></p>",
                "<p><img src=\"data:image/svg+xml;base64,PHN2Zz4=\" alt=\"svg\"></p>",
                "<p><img src=\"data:text/html;base64,PHNjcmlwdD4=\" alt=\"html\"></p>",
                "<p><img src=\"https://example.com/tracker.png\" alt=\"remote\"></p>",
                "<p><img src=\"{}\" width=\"../../../etc\" onerror=\"steal()\"></p>",
                "<p><img src=\"{}\" class=\"free wrap-left\" data-x=\"120\" data-y=\"-40\" data-width=\"420\"></p>",
                "<p><img src=\"{}\" class=\"free\" data-x=\"nope\" data-y=\"12;script\" data-width=\"0\"></p>"
            ),
            pixel, pixel, pixel, pixel
        );
        let clean = sanitize_content(&dirty);

        assert!(clean.contains("Before"));
        assert!(clean.contains(pixel));
        assert!(clean.contains("alt=\"A pixel\""));
        assert!(clean.contains("width=\"640\""));
        assert!(clean.contains("height=\"480\""));
        assert!(clean.contains("data-x=\"120\""));
        assert!(clean.contains("data-y=\"-40\""));
        assert!(clean.contains("data-width=\"420\""));
        assert!(clean.contains("class=\"free wrap-left\""));
        assert!(!clean.contains("data-x=\"nope\""));
        assert!(!clean.contains("data-width=\"0\""));
        assert!(!clean.contains("script"));
        assert!(!clean.contains("data:image/svg+xml"));
        assert!(!clean.contains("data:text/html"));
        assert!(!clean.contains("example.com"));
        assert!(!clean.contains("onerror"));
        assert!(!clean.contains("../../../etc"));
    }

    #[test]
    fn image_wrapping_survives_only_as_classes() {
        let pixel = "data:image/png;base64,iVBORw0KGgo=";
        let dirty = format!(
            concat!(
                "<img src=\"{}\" class=\"wrap-left portrait\" alt=\"left\">",
                "<img src=\"{}\" class=\"wrap-right\" style=\"float:right\" alt=\"right\">"
            ),
            pixel, pixel
        );
        let clean = sanitize_content(&dirty);

        assert!(clean.contains("class=\"wrap-left\""));
        assert!(clean.contains("class=\"wrap-right\""));
        assert!(!clean.contains("portrait"));
        assert!(!clean.contains("style"));
    }

    #[test]
    fn image_corner_radius_is_bounded() {
        let pixel = "data:image/png;base64,iVBORw0KGgo=";
        let dirty = format!(
            concat!(
                "<img src=\"{}\" data-radius=\"0\">",
                "<img src=\"{}\" data-radius=\"200\">",
                "<img src=\"{}\" data-radius=\"201\">",
                "<img src=\"{}\" data-radius=\"007\">",
                "<img src=\"{}\" data-radius=\"round\">"
            ),
            pixel, pixel, pixel, pixel, pixel
        );
        let clean = sanitize_content(&dirty);

        assert!(clean.contains("data-radius=\"0\""));
        assert!(clean.contains("data-radius=\"200\""));
        assert!(!clean.contains("data-radius=\"201\""));
        assert!(!clean.contains("data-radius=\"007\""));
        assert!(!clean.contains("data-radius=\"round\""));
    }

    #[test]
    fn paragraph_alignment_and_indent_are_bounded() {
        let dirty = concat!(
            "<p data-align=\"center\" data-indent=\"2\">Centered</p>",
            "<h2 data-align=\"right\" data-indent=\"9\">Too far</h2>",
            "<p data-align=\"left\" data-indent=\"0\">Plain</p>",
            "<ul><li data-align=\"justify\" data-indent=\"1\">Item</li></ul>",
            "<p data-align=\"diagonal\" data-indent=\"two\">Nope</p>",
        );
        let clean = sanitize_content(dirty);

        assert!(clean.contains("data-align=\"center\""));
        assert!(clean.contains("data-indent=\"2\""));
        assert!(clean.contains("data-align=\"right\""));
        assert!(!clean.contains("data-indent=\"9\""));
        assert!(!clean.contains("data-align=\"left\""));
        assert!(!clean.contains("data-indent=\"0\""));
        assert!(clean.contains("data-align=\"justify\""));
        assert!(!clean.contains("diagonal"));
        assert!(!clean.contains("data-indent=\"two\""));
    }

    #[test]
    fn heading_four_from_an_older_document_becomes_heading_three() {
        let clean = sanitize_content(concat!(
            "<h4>Small</h4>",
            "<h4 data-align=\"center\" data-indent=\"2\">Centered</h4>",
            "<h4 data-align=\"diagonal\">Bounded</h4>",
            "<p>A literal &lt;h4&gt; stays text</p>",
        ));

        assert!(clean.contains("<h3>Small</h3>"), "plain h4: {clean}");
        assert!(
            clean.contains("<h3 data-align=\"center\" data-indent=\"2\">Centered</h3>"),
            "attributes survive the demotion: {clean}"
        );
        assert!(!clean.contains("<h4"), "no heading four is stored: {clean}");
        assert!(
            !clean.contains("diagonal"),
            "attributes stay bounded: {clean}"
        );
        assert!(
            clean.contains("A literal &lt;h4&gt; stays text"),
            "escaped text is not a tag: {clean}"
        );
    }

    #[test]
    fn blank_lines_and_spacing_survive_sanitising() {
        let clean =
            sanitize_content("<p>one</p><p></p><p>two  three</p><p>tab\there</p><p>a<br><br>b</p>");

        assert!(
            clean.contains("<p></p>"),
            "an empty paragraph survives: {clean}"
        );
        assert!(
            clean.contains("two  three"),
            "repeated spaces survive: {clean}"
        );
        assert!(clean.contains("tab\there"), "a tab survives: {clean}");
        assert!(clean.contains("a<br><br>b"), "hard breaks survive: {clean}");
    }

    #[test]
    fn leading_indentation_survives_sanitising() {
        // The editor indents a selected line by putting four spaces in its
        // text, so leading whitespace has to survive the round trip exactly.
        let clean = sanitize_content("<p>    indented</p><p>    </p><p>first<br>    second</p>");

        assert!(
            clean.contains("<p>    indented</p>"),
            "leading spaces survive: {clean}"
        );
        assert!(
            clean.contains("<p>    </p>"),
            "a spaces-only paragraph survives: {clean}"
        );
        assert!(
            clean.contains("first<br>    second"),
            "indentation after a hard break survives: {clean}"
        );
    }

    #[test]
    fn data_urls_never_become_links() {
        let clean =
            sanitize_content("<a href=\"data:text/html;base64,PHNjcmlwdD4=\">click</a><p>text</p>");

        assert!(clean.contains("click"));
        assert!(!clean.contains("text/html"));
    }

    #[test]
    fn excerpts_end_on_words() {
        let text = "word ".repeat(100);
        let excerpt = make_excerpt(text.trim());
        assert!(excerpt.ends_with('…'));
        assert!(excerpt.chars().count() <= EXCERPT_CHARS);
        assert!(!excerpt.contains("  "));
    }

    #[test]
    fn a_preview_keeps_the_shape_of_a_page() {
        let html = concat!(
            "<h1>Field notes</h1>",
            "<p data-align=\"center\">One <b>bold</b> <i>italic</i> <u>under</u> ",
            "<s>struck</s> <code>inline</code> <a href=\"https://example.com\">linked</a></p>",
            "<ul><li>first</li><li>second</li></ul>",
            "<blockquote><p>A quote.</p></blockquote>",
            "<pre>let x = 1;\nlet y = 2;</pre>",
            "<p>After a <br>break &amp; an entity.</p>",
        );

        assert_eq!(
            preview_html(html),
            concat!(
                "<h1>Field notes</h1>",
                "<p>One <b>bold</b> <i>italic</i> <u>under</u> ",
                "<s>struck</s> <code>inline</code> linked</p>",
                "<ul><li>first</li><li>second</li></ul>",
                "<blockquote><p>A quote.</p></blockquote>",
                "<pre>let x = 1;\nlet y = 2;</pre>",
                "<p>After a <br>break &amp; an entity.</p>",
            )
        );
    }

    #[test]
    fn a_preview_replaces_images_and_never_carries_their_bytes() {
        let bytes = "A".repeat(4096);
        let html = format!("<p>Before</p><img src=\"data:image/png;base64,{bytes}\"><p>After</p>");

        assert_eq!(
            preview_html(&html),
            "<p>Before</p><span class=\"document-thumb-image\"></span><p>After</p>"
        );
    }

    #[test]
    fn a_preview_stops_after_one_page_of_text_with_closed_tags() {
        let html = format!(
            "<h2>Title</h2><p>{}</p><p>After the first page</p>",
            "word ".repeat(1000)
        );
        let preview = preview_html(&html);

        assert!(preview.starts_with("<h2>Title</h2><p>"));
        assert!(preview.ends_with("</p>"), "open tags are closed: {preview}");
        assert!(
            !preview.contains("After the first page"),
            "the preview stops at its text budget"
        );
        assert!(
            preview.len() < PREVIEW_TEXT_CHARS + 128,
            "the preview stays near its budget: {} bytes",
            preview.len()
        );
    }

    #[test]
    fn a_preview_does_not_read_a_document_far_past_its_scan_limit() {
        let huge = "A".repeat(PREVIEW_SCAN_BYTES * 2);
        let preview = preview_html(&format!("<img src=\"data:image/png;base64,{huge}\">"));

        assert_eq!(preview, "");
    }

    #[test]
    fn a_preview_escapes_text_and_closes_unclosed_tags() {
        assert_eq!(
            preview_html("<p>5 &lt; 6 &amp; 7 &gt; 6</p>"),
            "<p>5 &lt; 6 &amp; 7 &gt; 6</p>"
        );
        assert_eq!(preview_html("<p>open <b>bold"), "<p>open <b>bold</b></p>");
        assert_eq!(preview_html(""), "");
    }

    #[tokio::test]
    async fn documents_round_trip_through_disk() {
        let directory = std::env::temp_dir().join(format!("grapho-test-{}", Uuid::new_v4()));
        let store = Store::load(directory.clone()).await.expect("store loads");

        let document = store.create().await.expect("document is created");
        assert_eq!(store.list().await.len(), 1);

        let updated = store
            .update(
                document.id,
                Some("  A field note  ".to_owned()),
                Some("<p>Hello <strong>there</strong></p><script>x()</script>".to_owned()),
                Some(1180),
            )
            .await
            .expect("update succeeds")
            .expect("document exists");

        assert_eq!(updated.title, "A field note");
        assert!(updated.content.contains("<strong>there</strong>"));
        assert!(!updated.content.contains("script"));
        assert_eq!(updated.paper_width, Some(1180));

        let summary = store.list().await.remove(0);
        assert_eq!(summary.word_count, 2);
        assert_eq!(summary.excerpt, "Hello there");
        assert_eq!(summary.preview, "<p>Hello <b>there</b></p>");

        drop(store);
        let reloaded = Store::load(directory.clone()).await.expect("store reloads");
        let restored = reloaded.get(document.id).await.expect("document persists");
        assert_eq!(restored.title, "A field note");
        assert_eq!(restored.paper_width, Some(1180));

        let cleared = reloaded
            .update(document.id, None, None, Some(0))
            .await
            .expect("update succeeds")
            .expect("document exists");
        assert_eq!(cleared.paper_width, None);

        assert!(reloaded.delete(document.id).await.expect("delete succeeds"));
        assert!(reloaded.get(document.id).await.is_none());
        assert!(!directory.join(format!("{}.json", document.id)).exists());

        let _ = fs::remove_dir_all(directory).await;
    }

    fn temp_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("grapho-{label}-{}", Uuid::new_v4()))
    }

    #[tokio::test]
    async fn a_summary_falls_back_to_text_when_the_markup_starts_too_large() {
        let directory = temp_directory("huge-image-preview");
        let store = Store::load(directory.clone()).await.expect("store loads");
        let document = store.create().await.expect("document is created");

        let image = format!(
            "<img src=\"data:image/png;base64,{}\">",
            "A".repeat(PREVIEW_SCAN_BYTES * 2)
        );
        store
            .update(
                document.id,
                None,
                Some(format!("{image}<p>After the picture</p>")),
                None,
            )
            .await
            .expect("update succeeds");

        let summary = store.list().await.remove(0);
        assert_eq!(summary.preview, "<p>After the picture</p>");

        drop(store);
        let _ = fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn relocating_copies_the_library_and_writes_to_the_new_folder() {
        let old = temp_directory("old");
        let new = temp_directory("new");
        let store = Store::load(old.clone()).await.expect("store loads");

        let first = store.create().await.expect("document is created");
        let second = store.create().await.expect("document is created");
        store
            .update(first.id, Some("A field note".to_owned()), None, None)
            .await
            .expect("update succeeds");

        let relocated = store
            .relocate(new.clone())
            .await
            .expect("the library moves");
        assert_eq!(relocated.directory, new);
        assert_eq!(relocated.documents, 2);
        assert_eq!(store.directory().await, new);
        let usage = store.usage().await;
        assert_eq!(usage.documents, 2);
        assert!(usage.bytes > 0, "the copied documents have a size");

        // The old folder keeps its copy.
        for id in [first.id, second.id] {
            assert!(old.join(format!("{id}.json")).exists());
            assert!(new.join(format!("{id}.json")).exists());
        }

        // Writes and deletes follow the store to the new folder.
        store
            .update(second.id, Some("After moving".to_owned()), None, None)
            .await
            .expect("update succeeds");
        let moved = fs::read_to_string(new.join(format!("{}.json", second.id)))
            .await
            .expect("the new file exists");
        assert!(moved.contains("After moving"));
        let left_behind = fs::read_to_string(old.join(format!("{}.json", second.id)))
            .await
            .expect("the old file stays");
        assert!(!left_behind.contains("After moving"));

        assert!(store.delete(first.id).await.expect("delete succeeds"));
        assert!(!new.join(format!("{}.json", first.id)).exists());
        assert!(
            old.join(format!("{}.json", first.id)).exists(),
            "the old copy is never deleted"
        );

        drop(store);
        let reloaded = Store::load(new.clone()).await.expect("store reloads");
        assert_eq!(reloaded.list().await.len(), 1);
        assert_eq!(reloaded.get(second.id).await.unwrap().title, "After moving");

        let _ = fs::remove_dir_all(old).await;
        let _ = fs::remove_dir_all(new).await;
    }

    #[tokio::test]
    async fn relocating_refuses_a_folder_that_already_holds_documents() {
        let old = temp_directory("occupied-old");
        let occupied = temp_directory("occupied-target");
        fs::create_dir_all(&occupied).await.unwrap();
        let stranger = Uuid::new_v4();
        fs::write(occupied.join(format!("{stranger}.json")), b"{}")
            .await
            .unwrap();

        let store = Store::load(old.clone()).await.expect("store loads");
        store.create().await.expect("document is created");

        match store.relocate(occupied.clone()).await {
            Err(RelocateError::Occupied { documents }) => assert_eq!(documents, 1),
            other => panic!("expected an occupied folder, got {other:?}"),
        }
        assert_eq!(
            store.directory().await,
            old,
            "a refusal leaves the store where it was"
        );

        let _ = fs::remove_dir_all(old).await;
        let _ = fs::remove_dir_all(occupied).await;
    }

    #[tokio::test]
    async fn the_previous_folder_can_be_chosen_again() {
        let old = temp_directory("back-old");
        let new = temp_directory("back-new");
        let store = Store::load(old.clone()).await.expect("store loads");
        let document = store.create().await.expect("document is created");

        store
            .relocate(new.clone())
            .await
            .expect("the library moves");
        store
            .update(
                document.id,
                Some("Changed after moving".to_owned()),
                None,
                None,
            )
            .await
            .expect("update succeeds");

        // The old folder holds copies of these documents, not strangers.
        let moved_back = store
            .relocate(old.clone())
            .await
            .expect("the previous folder is accepted");
        assert_eq!(moved_back.directory, old);
        assert_eq!(store.directory().await, old);

        let content = fs::read_to_string(old.join(format!("{}.json", document.id)))
            .await
            .expect("the document is there");
        assert!(
            content.contains("Changed after moving"),
            "the folder now holds the current copy"
        );

        let _ = fs::remove_dir_all(old).await;
        let _ = fs::remove_dir_all(new).await;
    }

    #[tokio::test]
    async fn relocating_needs_an_absolute_folder_that_is_not_the_current_one() {
        let old = temp_directory("same-folder");
        let store = Store::load(old.clone()).await.expect("store loads");

        assert!(matches!(
            store.relocate(PathBuf::from("relative-folder")).await,
            Err(RelocateError::NotAbsolute)
        ));
        assert!(matches!(
            store.relocate(old.clone()).await,
            Err(RelocateError::SameDirectory)
        ));
        let with_separator =
            PathBuf::from(format!("{}{}", old.display(), std::path::MAIN_SEPARATOR));
        assert!(matches!(
            store.relocate(with_separator).await,
            Err(RelocateError::SameDirectory)
        ));

        let _ = fs::remove_dir_all(old).await;
    }

    #[tokio::test]
    async fn usage_ignores_everything_that_is_not_a_document() {
        let directory = temp_directory("usage");
        let store = Store::load(directory.clone()).await.expect("store loads");
        let document = store.create().await.expect("document is created");

        fs::write(directory.join("notes.txt"), b"hello")
            .await
            .unwrap();
        fs::write(directory.join("config.json"), b"{}")
            .await
            .unwrap();

        let usage = store.usage().await;
        assert_eq!(usage.documents, 1);
        let size = fs::metadata(directory.join(format!("{}.json", document.id)))
            .await
            .unwrap()
            .len();
        assert_eq!(usage.bytes, size);

        let _ = fs::remove_dir_all(directory).await;
    }
}
