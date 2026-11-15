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
    pub created_at: u64,
    pub updated_at: u64,
}

/// The compact shape used by the home page.
#[derive(Clone, Debug, Serialize)]
pub struct DocumentSummary {
    pub id: Uuid,
    pub title: String,
    pub excerpt: String,
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

/// A small, file-backed document store.
///
/// The in-memory map is the read path; every mutation is written through to
/// disk before it is acknowledged. This is intentionally simple and plenty for
/// a personal, single-user library, while keeping the data portable.
pub struct Store {
    directory: PathBuf,
    documents: RwLock<HashMap<Uuid, Document>>,
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

            documents.insert(id, document);
        }

        Ok(Self {
            directory,
            documents: RwLock::new(documents),
        })
    }

    pub async fn list(&self) -> Vec<DocumentSummary> {
        let documents = self.documents.read().await;
        let mut summaries: Vec<_> = documents.values().map(summary_for).collect();
        summaries.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.title.cmp(&right.title))
        });
        summaries
    }

    pub async fn get(&self, id: Uuid) -> Option<Document> {
        self.documents.read().await.get(&id).cloned()
    }

    pub async fn create(&self) -> Result<Document, StoreError> {
        let mut documents = self.documents.write().await;
        let now = now_millis();
        let document = Document {
            version: SCHEMA_VERSION,
            id: Uuid::new_v4(),
            title: "Untitled document".to_owned(),
            content: String::new(),
            created_at: now,
            updated_at: now,
        };

        persist_document(&self.directory, &document).await?;
        documents.insert(document.id, document.clone());
        Ok(document)
    }

    /// Apply a partial update. Sanitisation and title normalisation happen here,
    /// at the trust boundary, rather than in the browser.
    pub async fn update(
        &self,
        id: Uuid,
        title: Option<String>,
        content: Option<String>,
    ) -> Result<Option<Document>, StoreError> {
        let mut documents = self.documents.write().await;
        let Some(existing) = documents.get(&id).cloned() else {
            return Ok(None);
        };

        let next_title = title
            .map(|value| normalize_title(&value))
            .unwrap_or_else(|| existing.title.clone());
        let next_content = content
            .map(|value| sanitize_content(&value))
            .unwrap_or_else(|| existing.content.clone());

        if next_title == existing.title && next_content == existing.content {
            return Ok(Some(existing));
        }

        let updated_at = now_millis().max(existing.updated_at.saturating_add(1));
        let document = Document {
            version: SCHEMA_VERSION,
            id,
            title: next_title,
            content: next_content,
            created_at: existing.created_at,
            updated_at,
        };

        persist_document(&self.directory, &document).await?;
        documents.insert(id, document.clone());
        Ok(Some(document))
    }

    pub async fn delete(&self, id: Uuid) -> Result<bool, StoreError> {
        let mut documents = self.documents.write().await;
        if !documents.contains_key(&id) {
            return Ok(false);
        }

        let path = self.directory.join(format!("{id}.json"));
        match fs::remove_file(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(StoreError::Io(error)),
        }

        documents.remove(&id);
        Ok(true)
    }
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
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
        "h4",
        "i",
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
    let tag_attributes = HashMap::from([("a", link_attributes)]);
    let url_schemes = ["http", "https", "mailto"].into_iter().collect();

    Builder::default()
        .tags(tags)
        .tag_attributes(tag_attributes)
        .url_schemes(url_schemes)
        .link_rel(Some("noopener noreferrer"))
        .clean(html)
        .to_string()
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
        || [
            "/p",
            "/div",
            "/h1",
            "/h2",
            "/h3",
            "/h4",
            "/li",
            "/blockquote",
            "/pre",
        ]
        .iter()
        .any(|prefix| tag.starts_with(prefix))
}

fn summary_for(document: &Document) -> DocumentSummary {
    let text = html_to_text(&document.content);
    DocumentSummary {
        id: document.id,
        title: document.title.clone(),
        excerpt: make_excerpt(&text),
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

async fn persist_document(directory: &Path, document: &Document) -> Result<(), StoreError> {
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
async fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination).await
}

/// Windows does not replace an existing file with `rename`. Keep the previous
/// version until the new file is safely in place, then remove the backup.
#[cfg(windows)]
async fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
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
    fn excerpts_end_on_words() {
        let text = "word ".repeat(100);
        let excerpt = make_excerpt(text.trim());
        assert!(excerpt.ends_with('…'));
        assert!(excerpt.chars().count() <= EXCERPT_CHARS);
        assert!(!excerpt.contains("  "));
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
            )
            .await
            .expect("update succeeds")
            .expect("document exists");

        assert_eq!(updated.title, "A field note");
        assert!(updated.content.contains("<strong>there</strong>"));
        assert!(!updated.content.contains("script"));

        let summary = store.list().await.remove(0);
        assert_eq!(summary.word_count, 2);
        assert_eq!(summary.excerpt, "Hello there");

        drop(store);
        let reloaded = Store::load(directory.clone()).await.expect("store reloads");
        assert_eq!(
            reloaded
                .get(document.id)
                .await
                .expect("document persists")
                .title,
            "A field note"
        );

        assert!(reloaded.delete(document.id).await.expect("delete succeeds"));
        assert!(reloaded.get(document.id).await.is_none());
        assert!(!directory.join(format!("{}.json", document.id)).exists());

        let _ = fs::remove_dir_all(directory).await;
    }
}
