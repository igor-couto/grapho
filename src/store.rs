use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
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

use crate::markdown::{self, ImageAttributes};

const SCHEMA_VERSION: u32 = 1;
const DEFAULT_TITLE: &str = "Untitled document";
pub(crate) const INDEX_FILE: &str = "metadata.json";
const SPELLING_WORDS_FILE: &str = "spelling-words.json";
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

/// The editor's document shape, served over the JSON API.
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deleted_at: Option<u64>,
}

#[derive(Clone, Serialize, Deserialize)]
struct DocumentMetadata {
    title: String,
    created_at: u64,
    updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    paper_width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deleted_at: Option<u64>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    images: ImageAttributes,
}

impl DocumentMetadata {
    fn from_document(document: &Document, images: ImageAttributes) -> Self {
        Self {
            title: document.title.clone(),
            created_at: document.created_at,
            updated_at: document.updated_at,
            paper_width: document.paper_width,
            deleted_at: document.deleted_at,
            images,
        }
    }

    fn document(&self, id: Uuid, content: String) -> Document {
        Document {
            version: SCHEMA_VERSION,
            id,
            title: normalize_title(&self.title),
            created_at: self.created_at,
            updated_at: self.updated_at,
            paper_width: self.paper_width.map(bounded_paper_width),
            deleted_at: self.deleted_at,
            content,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct LibraryIndex {
    version: u32,
    documents: BTreeMap<Uuid, DocumentMetadata>,
}

impl Default for LibraryIndex {
    fn default() -> Self {
        Self {
            version: SCHEMA_VERSION,
            documents: BTreeMap::new(),
        }
    }
}

pub(crate) struct BackupSnapshot {
    pub known: HashSet<Uuid>,
    pub changed: HashSet<Uuid>,
    pub files: BTreeMap<String, Vec<u8>>,
    pub index: Vec<u8>,
}

impl BackupSnapshot {
    /// Keep anything outside the changed documents, including unrelated files.
    pub fn obsolete(&self, name: &str) -> bool {
        managed_file_id(name).is_some_and(|id| self.changed.contains(&id))
            && !self.files.contains_key(name)
    }
}

impl Document {
    fn blank(id: Uuid) -> Self {
        let now = now_millis();
        Self {
            version: SCHEMA_VERSION,
            id,
            title: DEFAULT_TITLE.to_owned(),
            content: String::new(),
            paper_width: None,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        }
    }
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

#[derive(Serialize)]
pub struct DeletedDocument {
    id: Uuid,
    title: String,
    deleted_at: u64,
}

#[derive(Serialize)]
pub struct DocumentMatch {
    #[serde(flatten)]
    summary: DocumentSummary,
    #[serde(skip_serializing_if = "Option::is_none")]
    title_match: Option<SearchExcerpt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_match: Option<SearchExcerpt>,
}

#[derive(Serialize)]
struct SearchExcerpt {
    before: String,
    matched: String,
    after: String,
}

#[derive(Debug)]
pub enum StoreError {
    EmptyDraft,
    Io(io::Error),
    Corrupt { path: PathBuf, message: String },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyDraft => write!(f, "empty untitled draft"),
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
            Self::EmptyDraft | Self::Corrupt { .. } => None,
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
    index: LibraryIndex,
}

impl Store {
    pub async fn load(directory: PathBuf) -> Result<Self, StoreError> {
        fs::create_dir_all(&directory).await?;

        let mut index = read_index(&directory).await?;
        let mut documents = HashMap::new();
        let mut bodies = Vec::new();
        let mut attachments: HashMap<Uuid, Vec<String>> = HashMap::new();
        let mut entries = fs::read_dir(&directory).await?;

        while let Some(entry) = entries.next_entry().await? {
            if !entry.file_type().await?.is_file() {
                continue;
            }
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if let Some(id) = document_file_id(Path::new(&name)) {
                bodies.push(id);
            } else if let Some(id) = markdown::attachment_owner(&name) {
                attachments.entry(id).or_default().push(name);
            }
        }

        for id in bodies {
            let source = fs::read_to_string(directory.join(document_file_name(id))).await?;
            let metadata = index.documents.entry(id).or_insert_with(|| {
                DocumentMetadata::from_document(&Document::blank(id), ImageAttributes::new())
            });
            let mut images = BTreeMap::new();
            for name in attachments.remove(&id).into_iter().flatten() {
                if source.contains(&name) {
                    let bytes = fs::read(directory.join(&name)).await?;
                    metadata.images.entry(name.clone()).or_default();
                    images.insert(name, bytes);
                }
            }
            metadata.images.retain(|name, _| images.contains_key(name));

            // Markdown and index edits cross the same trust boundary as API saves.
            let content =
                sanitize_document_content(markdown::decode(&source, &images, &metadata.images));
            let document = metadata.document(id, content);
            documents.insert(id, document);
        }
        index.documents.retain(|id, _| documents.contains_key(id));

        Ok(Self {
            state: RwLock::new(State {
                directory,
                documents,
                index,
            }),
        })
    }

    /// The folder documents are written to right now.
    pub async fn directory(&self) -> PathBuf {
        self.state.read().await.directory.clone()
    }

    pub async fn spelling_words(&self) -> io::Result<BTreeSet<String>> {
        let state = self.state.read().await;
        read_spelling_words(&state.directory).await
    }

    pub async fn add_spelling_word(&self, word: String) -> io::Result<BTreeSet<String>> {
        let state = self.state.write().await;
        let mut words = read_spelling_words(&state.directory).await?;
        if words.insert(word) {
            crate::settings::write_json(&state.directory.join(SPELLING_WORDS_FILE), &words).await?;
        }
        Ok(words)
    }

    /// What the folder holds, counted from the files themselves rather than the
    /// in-memory map, so a hand-edited folder is reported honestly.
    pub async fn usage(&self) -> Usage {
        let state = self.state.read().await;
        let files = document_files(&state.directory).await;
        Usage {
            documents: files
                .iter()
                .filter(|(id, _)| {
                    !state
                        .documents
                        .get(id)
                        .is_some_and(|doc| doc.deleted_at.is_some())
                })
                .count(),
            bytes: files.iter().fold(
                library_overhead(&state.directory, &state.index).await,
                |total: u64, (_, bytes)| total.saturating_add(*bytes),
            ),
        }
    }

    pub async fn list(&self) -> Vec<DocumentSummary> {
        let state = self.state.read().await;
        let mut summaries: Vec<_> = state
            .documents
            .values()
            .filter(|document| document.deleted_at.is_none())
            .map(summary_for)
            .collect();
        summaries.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.title.cmp(&right.title))
        });
        summaries
    }

    pub async fn list_deleted(&self) -> Vec<DeletedDocument> {
        let state = self.state.read().await;
        let mut documents: Vec<_> = state
            .documents
            .values()
            .filter_map(|document| {
                Some(DeletedDocument {
                    id: document.id,
                    deleted_at: document.deleted_at?,
                    title: document.title.clone(),
                })
            })
            .collect();
        documents.sort_by(|left, right| {
            right
                .deleted_at
                .cmp(&left.deleted_at)
                .then_with(|| left.title.cmp(&right.title))
        });
        documents
    }

    pub async fn search(&self, query: &str) -> Vec<DocumentMatch> {
        let query = fold_for_search(&query.split_whitespace().collect::<Vec<_>>().join(" "));
        if query.is_empty() {
            return Vec::new();
        }

        let state = self.state.read().await;
        state
            .documents
            .values()
            .filter(|document| document.deleted_at.is_none())
            .filter_map(|document| {
                let text = html_to_text(&document.content);
                let title_match = search_excerpt(&document.title, &query);
                let body_match = search_excerpt(&text, &query);
                if title_match.is_none() && body_match.is_none() {
                    return None;
                }
                Some(DocumentMatch {
                    summary: summarize(document, &text),
                    title_match,
                    body_match,
                })
            })
            .collect()
    }

    pub async fn get(&self, id: Uuid) -> Option<Document> {
        self.state.read().await.active_document(id).cloned()
    }

    pub async fn title(&self, id: Uuid) -> Option<String> {
        self.state
            .read()
            .await
            .active_document(id)
            .map(|doc| doc.title.clone())
    }

    pub(crate) async fn contains_active(&self, id: Uuid) -> bool {
        self.is_deleted(id).await == Some(false)
    }

    async fn is_deleted(&self, id: Uuid) -> Option<bool> {
        self.state
            .read()
            .await
            .documents
            .get(&id)
            .map(|document| document.deleted_at.is_some())
    }

    /// Read the files and index while they describe the same committed state.
    /// Connectors perform all network and destination I/O after this lock drops.
    pub(crate) async fn backup_snapshot(
        &self,
        ids: Option<&HashSet<Uuid>>,
    ) -> io::Result<BackupSnapshot> {
        let state = self.state.read().await;
        let mut index = state.index.clone();
        index
            .documents
            .retain(|_, metadata| metadata.deleted_at.is_none());
        let known: HashSet<_> = index.documents.keys().copied().collect();
        let changed: HashSet<_> = match ids {
            Some(ids) => ids
                .iter()
                .filter(|id| state.documents.contains_key(id))
                .copied()
                .collect(),
            None => known.clone(),
        };
        let mut files = BTreeMap::new();
        for id in changed.intersection(&known) {
            for name in document_files_for(*id, &index.documents[id]) {
                let bytes = fs::read(state.directory.join(&name)).await?;
                files.insert(name, bytes);
            }
        }
        Ok(BackupSnapshot {
            known,
            changed,
            files,
            index: index_bytes(&index)?,
        })
    }

    pub async fn create(&self) -> Result<Document, StoreError> {
        let mut state = self.state.write().await;
        let document = Document::blank(Uuid::new_v4());

        state.persist(document.clone()).await?;
        Ok(document)
    }

    /// Copy a document into a new file.
    ///
    /// The copy is a document in its own right: a fresh id and timestamps, its
    /// own file on disk, and a title that says where it came from. It shares the
    /// writing and the paper width with the source, and the source is not
    /// touched. One write goes through the same path as every other save, so a
    /// failure leaves the library exactly as it was.
    pub async fn duplicate(&self, id: Uuid) -> Result<Option<Document>, StoreError> {
        let mut state = self.state.write().await;
        let Some(source) = state.active_document(id).cloned() else {
            return Ok(None);
        };

        let now = now_millis();
        // The copy's title is chosen from the titles the library already uses,
        // so two copies of the same document never end up with one name.
        let title = {
            let taken: HashSet<&str> = state
                .documents
                .values()
                .filter(|document| document.deleted_at.is_none())
                .map(|document| document.title.as_str())
                .collect();
            copy_title(&source.title, &taken)
        };
        let document = Document {
            version: SCHEMA_VERSION,
            id: Uuid::new_v4(),
            title,
            content: source.content,
            paper_width: source.paper_width,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        };

        state.persist(document.clone()).await?;
        Ok(Some(document))
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
        self.save(id, title, content, paper_width, false).await
    }

    /// A draft already has an id, so a retry of the first save updates the
    /// same file even if the first response never reached the editor.
    pub async fn save_draft(
        &self,
        id: Uuid,
        title: Option<String>,
        content: Option<String>,
        paper_width: Option<u32>,
    ) -> Result<Option<Document>, StoreError> {
        self.save(id, title, content, paper_width, true).await
    }

    async fn save(
        &self,
        id: Uuid,
        title: Option<String>,
        content: Option<String>,
        paper_width: Option<u32>,
        allow_create: bool,
    ) -> Result<Option<Document>, StoreError> {
        let mut state = self.state.write().await;
        let (mut document, creating) = match state.documents.get(&id) {
            Some(document) if document.deleted_at.is_none() => (document.clone(), false),
            None if allow_create => (Document::blank(id), true),
            _ => return Ok(None),
        };

        let next_title = title
            .map(|value| normalize_title(&value))
            .unwrap_or_else(|| document.title.clone());
        let next_content = content
            .map(sanitize_document_content)
            .unwrap_or_else(|| document.content.clone());
        let next_paper_width = match paper_width {
            // The browser sends zero when the width snaps back to the default,
            // which removes the stored preference instead of pinning a pixel
            // value that should follow the stylesheet.
            Some(0) => None,
            Some(width) => Some(bounded_paper_width(width)),
            None => document.paper_width,
        };

        if creating {
            if next_title == DEFAULT_TITLE
                && !next_content.contains("<hr>")
                && !next_content.contains(" src=\"data:image/")
                && html_to_text(&next_content).is_empty()
            {
                return Err(StoreError::EmptyDraft);
            }
        } else {
            if next_title == document.title
                && next_content == document.content
                && next_paper_width == document.paper_width
            {
                return Ok(Some(document));
            }
            document.updated_at = now_millis().max(document.updated_at.saturating_add(1));
        }

        document.version = SCHEMA_VERSION;
        document.title = next_title;
        document.content = next_content;
        document.paper_width = next_paper_width;

        state.persist(document.clone()).await?;
        Ok(Some(document))
    }

    pub async fn delete(&self, id: Uuid) -> Result<bool, StoreError> {
        let mut state = self.state.write().await;
        let Some(mut document) = state.active_document(id).cloned() else {
            return Ok(false);
        };

        document.deleted_at = Some(now_millis());
        state.persist(document).await?;
        Ok(true)
    }

    pub async fn restore(&self, id: Uuid) -> Result<Option<Document>, StoreError> {
        let mut state = self.state.write().await;
        let Some(mut document) = state.documents.get(&id).cloned() else {
            return Ok(None);
        };
        if document.deleted_at.take().is_some() {
            state.persist(document.clone()).await?;
        }
        Ok(Some(document))
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
        let current_key = directory_key(&state.directory)
            .await
            .map_err(|error| RelocateError::io(&state.directory, error))?;
        if current_key
            == directory_key(&target)
                .await
                .map_err(|error| RelocateError::io(&target, error))?
        {
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

        let spelling_words = read_spelling_words(&state.directory)
            .await
            .map_err(|error| RelocateError::io(&state.directory, error))?;

        // Copies this call creates are the only ones a failure may remove; a
        // file that was already there belongs to the folder's previous use.
        let mut created = Vec::new();
        for (id, metadata) in &state.index.documents {
            for name in document_files_for(*id, metadata) {
                let destination = target.join(&name);
                let existed = fs::symlink_metadata(&destination).await.is_ok();
                let copy = async {
                    let bytes = fs::read(state.directory.join(name)).await?;
                    write_data_file(&destination, &bytes).await
                };
                if let Err(error) = copy.await {
                    remove_copies(&created).await;
                    return Err(RelocateError::io(&target, error));
                }
                if !existed {
                    created.push(destination);
                }
            }
        }

        // When returning to a previous data folder, retain any words added there.
        if !spelling_words.is_empty() {
            let copied = async {
                let mut words = read_spelling_words(&target).await?;
                words.extend(spelling_words);
                crate::settings::write_json(&target.join(SPELLING_WORDS_FILE), &words).await
            }
            .await;
            if let Err(error) = copied {
                remove_copies(&created).await;
                return Err(RelocateError::io(&target, error));
            }
        }

        let index = index_bytes(&state.index).map_err(|error| RelocateError::io(&target, error))?;
        if let Err(error) = write_data_file(&target.join(INDEX_FILE), &index).await {
            remove_copies(&created).await;
            return Err(RelocateError::io(&target, error));
        }

        state.directory = target.clone();
        Ok(Relocated {
            directory: target,
            documents: state
                .documents
                .values()
                .filter(|doc| doc.deleted_at.is_none())
                .count(),
        })
    }
}

async fn read_spelling_words(directory: &Path) -> io::Result<BTreeSet<String>> {
    match fs::read(directory.join(SPELLING_WORDS_FILE)).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(io::Error::from),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(error) => Err(error),
    }
}

impl State {
    fn active_document(&self, id: Uuid) -> Option<&Document> {
        self.documents
            .get(&id)
            .filter(|doc| doc.deleted_at.is_none())
    }

    async fn persist(&mut self, document: Document) -> Result<(), StoreError> {
        let id = document.id;
        let path = self.directory.join(document_file_name(id));
        let old_metadata = self.index.documents.get(&id);
        let mut created = Vec::new();
        let mut old_body = None;
        let body_changed = self
            .documents
            .get(&id)
            .is_none_or(|old| old.content != document.content);
        let image_attributes = if body_changed {
            let body = markdown::encode(id, &document.content);
            if old_metadata.is_some() {
                old_body = Some(fs::read(&path).await?);
            }
            let write = async {
                for (name, bytes) in body.images {
                    let image = self.directory.join(name);
                    if !fs::symlink_metadata(&image)
                        .await
                        .is_ok_and(|file| file.is_file())
                    {
                        write_data_file(&image, &bytes).await?;
                        created.push(image);
                    }
                }
                write_data_file(&path, body.markdown.as_bytes()).await
            };
            if let Err(error) = write.await {
                remove_copies(&created).await;
                return Err(error.into());
            }
            body.image_attributes
        } else {
            old_metadata.map_or_else(ImageAttributes::new, |old| old.images.clone())
        };

        let metadata = DocumentMetadata::from_document(&document, image_attributes);
        let previous = self.index.documents.insert(id, metadata);
        let index = async {
            let bytes = index_bytes(&self.index)?;
            write_data_file(&self.directory.join(INDEX_FILE), &bytes).await
        };
        if let Err(error) = index.await {
            self.index.documents.remove(&id);
            if let Some(previous) = previous {
                self.index.documents.insert(id, previous);
            }
            if body_changed {
                let restored = match old_body {
                    Some(bytes) => write_data_file(&path, &bytes).await,
                    None => fs::remove_file(path).await,
                };
                if let Err(rollback) = restored {
                    eprintln!("could not roll back Markdown save for {id}: {rollback}");
                } else {
                    remove_copies(&created).await;
                }
            }
            return Err(error.into());
        }

        if let Some(previous) = previous {
            let current = &self.index.documents[&id];
            for name in previous
                .images
                .keys()
                .filter(|name| !current.images.contains_key(*name))
            {
                let _ = fs::remove_file(self.directory.join(name)).await;
            }
        }
        self.documents.insert(id, document);
        Ok(())
    }
}

async fn read_index(directory: &Path) -> Result<LibraryIndex, StoreError> {
    let path = directory.join(INDEX_FILE);
    let bytes = match fs::read(&path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(LibraryIndex::default()),
        Err(error) => return Err(error.into()),
    };
    let index: LibraryIndex =
        serde_json::from_slice(&bytes).map_err(|error| StoreError::Corrupt {
            path: path.clone(),
            message: error.to_string(),
        })?;
    if index.version != SCHEMA_VERSION {
        return Err(StoreError::Corrupt {
            path,
            message: format!("unsupported metadata index version {}", index.version),
        });
    }
    Ok(index)
}

fn index_bytes(index: &LibraryIndex) -> io::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(index)?;
    bytes.push(b'\n');
    Ok(bytes)
}

async fn library_overhead(directory: &Path, index: &LibraryIndex) -> u64 {
    let mut bytes = fs::metadata(directory.join(INDEX_FILE))
        .await
        .map_or(0, |file| file.len());
    for metadata in index.documents.values() {
        for name in metadata.images.keys() {
            if let Ok(file) = fs::metadata(directory.join(name)).await {
                bytes = bytes.saturating_add(file.len());
            }
        }
    }
    bytes
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

/// A document file is a UUID name with an .md extension. Anything else in the
/// folder belongs to someone else and is never counted, copied, or removed.
pub(crate) fn document_file_id(path: &Path) -> Option<Uuid> {
    if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
        return None;
    }
    let stem = path.file_stem()?.to_str()?;
    let id = Uuid::parse_str(stem).ok()?;
    (id.to_string() == stem).then_some(id)
}

pub(crate) fn managed_file_id(name: &str) -> Option<Uuid> {
    let path = Path::new(name);
    if path.file_name()?.to_str()? != name {
        return None;
    }
    document_file_id(path).or_else(|| markdown::attachment_owner(name))
}

pub(crate) fn document_file_name(id: Uuid) -> String {
    format!("{id}.md")
}

fn document_files_for(id: Uuid, metadata: &DocumentMetadata) -> impl Iterator<Item = String> + '_ {
    metadata
        .images
        .keys()
        .cloned()
        .chain(std::iter::once(document_file_name(id)))
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
        if metadata.is_file() {
            files.push((id, metadata.len()));
        }
    }

    files
}

/// Resolve aliases before comparing folders. Newly chosen folders can have
/// missing components, including a missing child beneath an existing symlink.
pub(crate) async fn directory_key(path: &Path) -> io::Result<PathBuf> {
    let mut resolved = match fs::canonicalize(path).await {
        Ok(real) => real,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let mut prefix = PathBuf::new();
            for component in path.components() {
                match component {
                    std::path::Component::ParentDir => {
                        prefix.pop();
                    }
                    std::path::Component::Normal(name) => {
                        prefix.push(name);
                        match fs::canonicalize(&prefix).await {
                            Ok(real) => prefix = real,
                            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                            Err(error) => return Err(error),
                        }
                    }
                    _ => prefix.push(component),
                }
            }
            prefix
        }
        Err(error) => return Err(error),
    };
    if cfg!(windows) {
        resolved.as_mut_os_string().make_ascii_lowercase();
    }
    Ok(resolved)
}

/// Best effort: the documents that were copied before a failure go away again,
/// so a second attempt does not meet its own leftovers.
async fn remove_copies(written: &[PathBuf]) {
    for path in written {
        let _ = fs::remove_file(path).await;
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
        DEFAULT_TITLE.to_owned()
    } else {
        title
    }
}

/// The title of a copy: `Notes` becomes `Notes (copy)`, and copying a copy
/// moves the number along (`Notes (copy 2)`) instead of stacking suffixes. A
/// number whose title the library already uses is skipped, and the result
/// always fits within `MAX_TITLE_CHARS`.
fn copy_title(source: &str, taken: &HashSet<&str>) -> String {
    let (base, mut number) = copy_base(source);

    loop {
        let suffix = if number == 1 {
            " (copy)".to_owned()
        } else {
            format!(" (copy {number})")
        };
        let room = MAX_TITLE_CHARS.saturating_sub(suffix.chars().count());
        let stem: String = base.chars().take(room).collect();
        let stem = stem.trim_end();
        let stem = if stem.is_empty() {
            "Untitled document"
        } else {
            stem
        };
        let candidate = format!("{stem}{suffix}");
        if !taken.contains(candidate.as_str()) {
            return candidate;
        }
        number = number.saturating_add(1);
    }
}

/// What a copy of `title` should be based on, and the first number to try.
/// Only the suffix `copy_title` writes is understood, so an unrelated title
/// that happens to end the same way is just used as the base.
fn copy_base(title: &str) -> (&str, u64) {
    if let Some(base) = title.strip_suffix(" (copy)") {
        return (base, 2);
    }
    if let Some((base, tail)) = title.rsplit_once(" (copy ") {
        if let Some(number) = tail
            .strip_suffix(')')
            .and_then(|digits| digits.parse::<u64>().ok())
        {
            return (base, number.saturating_add(1));
        }
    }
    (title, 1)
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
        "hr",
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

    protect_code_newlines(demote_heading_four(clean))
}

/// In Grapho's serialized HTML, text and attribute values have their angle
/// brackets escaped. A newline here is the first character of a code block.
/// HTML parsers discard it immediately after <pre>, but keep it in a span.
fn protect_code_newlines(html: String) -> String {
    if html.contains("<pre>\n") {
        html.replace("<pre>\n", "<pre><span>\n</span>")
    } else {
        html
    }
}

fn sanitize_document_content(html: String) -> String {
    // Older files and still-open editor tabs put the first newline directly
    // after <pre>. Preserve it before the HTML parser reads the document.
    sanitize_content(&protect_code_newlines(html))
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
    const PREFIXES: [&str; 5] = [
        "data:image/png;base64,",
        "data:image/jpeg;base64,",
        "data:image/webp;base64,",
        "data:image/gif;base64,",
        "data:image/avif;base64,",
    ];
    PREFIXES
        .iter()
        .any(|prefix| value.len() > prefix.len() && value.starts_with(prefix))
}

/// Convert safe stored HTML into text for summaries, word counts, and search.
pub fn html_to_text(html: &str) -> String {
    let mut raw = String::new();
    let mut index = 0;

    while index < html.len() {
        let rest = &html[index..];
        let Some(character) = rest.chars().next() else {
            break;
        };

        if character == '<' {
            if let Some(relative_end) = rest.find('>') {
                // Attributes can contain megabytes of embedded image data.
                // Only the name determines how to join the surrounding words.
                let tag = &rest[1..relative_end];
                let name = tag.split_ascii_whitespace().next().unwrap_or("");
                if is_line_break_tag(name.trim_end_matches('/')) {
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
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_line_break_tag(tag: &str) -> bool {
    matches!(
        tag.trim_start_matches('/'),
        "br" | "img" | "hr" | "p" | "div" | "h1" | "h2" | "h3" | "li" | "blockquote" | "pre"
    )
}

fn fold_for_search(text: &str) -> String {
    text.chars().flat_map(char::to_lowercase).collect()
}

fn search_excerpt(text: &str, query: &str) -> Option<SearchExcerpt> {
    let folded_start = fold_for_search(text).find(query)?;
    let folded_end = folded_start + query.len();
    let mut folded_offset = 0;
    let mut start = 0;
    let mut end = text.len();

    // Lowercasing can change a character's length (for example, İ becomes
    // i plus a combining dot). Find the original character boundaries.
    for (offset, character) in text.char_indices() {
        if folded_offset >= folded_end {
            end = offset;
            break;
        }
        if folded_offset <= folded_start {
            start = offset;
        }
        folded_offset += character.to_lowercase().map(char::len_utf8).sum::<usize>();
    }

    let prefix = &text[..start];
    let suffix = &text[end..];
    let before = match prefix.char_indices().rev().nth(40) {
        Some((cut, character)) => {
            let tail = &prefix[cut + character.len_utf8()..];
            let tail = tail.split_once(' ').map_or(tail, |(_, words)| words);
            format!("…{tail}")
        }
        None => prefix.to_owned(),
    };
    let matched = match text[start..end].char_indices().nth(120) {
        Some((cut, _)) => format!("{}…", &text[start..start + cut]),
        None => text[start..end].to_owned(),
    };
    let after = match suffix.char_indices().nth(65) {
        Some((cut, _)) => {
            let head = &suffix[..cut];
            let head = head.rsplit_once(' ').map_or(head, |(words, _)| words);
            format!("{head}…")
        }
        None => suffix.to_owned(),
    };
    Some(SearchExcerpt {
        before,
        matched,
        after,
    })
}

pub(crate) fn summary_for(document: &Document) -> DocumentSummary {
    summarize(document, &html_to_text(&document.content))
}

fn summarize(document: &Document, text: &str) -> DocumentSummary {
    let mut preview = preview_html(&document.content);
    if preview.is_empty() && !text.is_empty() {
        // The markup started with something larger than the preview's scan
        // window (a document that opens with a big embedded image, say). The
        // text is already here, so the card still shows the writing.
        preview = text_preview(text);
    }
    DocumentSummary {
        id: document.id,
        title: document.title.clone(),
        excerpt: make_excerpt(text),
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
                    "hr" => output.push_str("<hr>"),
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

    protect_code_newlines(output)
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
        "hr" => "hr",
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

pub(crate) async fn write_data_file(destination: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut name = std::ffi::OsString::from(".");
    name.push(destination.file_name().expect("data files have a name"));
    name.push(".tmp");
    let temporary = destination.with_file_name(name);
    let write = async {
        let mut file = fs::File::create(&temporary).await?;
        file.write_all(bytes).await?;
        file.sync_all().await?;
        drop(file);
        replace_file(&temporary, destination).await
    };
    let result = write.await;
    if result.is_err() {
        let _ = fs::remove_file(&temporary).await;
    }
    result
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
            if !destination.is_file() {
                return Err(first_error);
            }

            let mut name = destination.as_os_str().to_owned();
            name.push(".bak");
            let backup = PathBuf::from(name);
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
    fn copy_titles_are_numbered_and_bounded() {
        let taken = HashSet::new();
        assert_eq!(copy_title("Notes", &taken), "Notes (copy)");
        assert_eq!(copy_title("Notes (copy)", &taken), "Notes (copy 2)");
        assert_eq!(copy_title("Notes (copy 7)", &taken), "Notes (copy 8)");
        assert_eq!(
            copy_title("Notes (copy 1)", &taken),
            "Notes (copy 2)",
            "the first copy of a title numbered by hand is not a duplicate name"
        );

        // The suffix never pushes a title past the storage limit, including the
        // longer numbered suffix.
        let long = "é".repeat(MAX_TITLE_CHARS);
        for title in [
            copy_title(&long, &taken),
            copy_title(&format!("{long} (copy)"), &taken),
        ] {
            assert_eq!(title.chars().count(), MAX_TITLE_CHARS);
            assert!(title.ends_with(" (copy)") || title.ends_with(" (copy 2)"));
        }

        // A name already in the library is skipped.
        let taken = HashSet::from(["Notes (copy)", "Notes (copy 2)"]);
        assert_eq!(copy_title("Notes", &taken), "Notes (copy 3)");
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
        assert_eq!(
            html_to_text("<ul><li>Parent<ul><li>Child</li></ul></li></ul>"),
            "Parent Child"
        );
    }

    #[test]
    fn images_must_be_embedded_bitmaps() {
        let pixel = "data:image/png;base64,iVBORw0KGgo=";
        let avif = "data:image/avif;base64,AAAA";
        let dirty = format!(
            concat!(
                "<p>Before</p>",
                "<p><img src=\"{}\" alt=\"A pixel\" width=\"640\" height=\"480\"></p>",
                "<p><img src=\"{}\" alt=\"An AVIF\"></p>",
                "<p><img src=\"data:image/svg+xml;base64,PHN2Zz4=\" alt=\"svg\"></p>",
                "<p><img src=\"data:text/html;base64,PHNjcmlwdD4=\" alt=\"html\"></p>",
                "<p><img src=\"https://example.com/tracker.png\" alt=\"remote\"></p>",
                "<p><img src=\"{}\" width=\"../../../etc\" onerror=\"steal()\"></p>",
                "<p><img src=\"{}\" class=\"free wrap-left\" data-x=\"120\" data-y=\"-40\" data-width=\"420\"></p>",
                "<p><img src=\"{}\" class=\"free\" data-x=\"nope\" data-y=\"12;script\" data-width=\"0\"></p>"
            ),
            pixel, avif, pixel, pixel, pixel
        );
        let clean = sanitize_content(&dirty);

        assert!(clean.contains("Before"));
        assert!(clean.contains(pixel));
        assert!(clean.contains(avif));
        assert!(clean.contains("alt=\"A pixel\""));
        assert!(clean.contains("alt=\"An AVIF\""));
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
    fn dividers_survive_sanitising_without_attributes() {
        let clean = sanitize_content(concat!(
            "<p>Above</p>",
            "<hr>",
            "<hr data-x=\"1\" data-align=\"center\" onclick=\"alert(1)\" style=\"color:red\">",
            "<p>Below</p>",
        ));

        assert_eq!(
            clean.matches("<hr>").count(),
            2,
            "both rules are kept, and bare: {clean}"
        );
        assert!(!clean.contains("onclick"), "no script attributes: {clean}");
        assert!(!clean.contains("data-x"), "no image attributes: {clean}");
        assert!(
            !clean.contains("data-align"),
            "a rule has no alignment: {clean}"
        );
        assert!(!clean.contains("style"), "no inline styles: {clean}");
        assert!(
            clean.contains("<p>Above</p>"),
            "text around it survives: {clean}"
        );
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
    fn regression_code_block_spacing_survives_reopening() {
        for text in ["\n", "\n\n", "\n\nreturn 42;\n"] {
            // Store input from the current editor, then sanitize it again
            // as on reopen. The first newline is inside a neutral span.
            let saved = format!("<pre><span>\n</span>{}</pre>", &text[1..]);
            assert_eq!(sanitize_content(&saved), saved);
        }
        // Cleaning imported HTML can itself expose a leading newline, for
        // example when a comment before the newline is removed.
        let saved = sanitize_content("<pre><!-- a comment -->\n\nreturn 42;</pre>");
        assert_eq!(saved, "<pre><span>\n</span>\nreturn 42;</pre>");
        assert_eq!(sanitize_content(&saved), saved);
        assert_eq!(preview_html(&saved), saved);
    }

    #[tokio::test]
    async fn fenced_code_keeps_its_leading_newlines_on_disk() {
        let directory = temp_directory("fenced-code");
        fs::create_dir_all(&directory).await.unwrap();
        let id = Uuid::new_v4();
        fs::write(
            directory.join(document_file_name(id)),
            "\x60\x60\x60\n\n\nreturn 42;\n\x60\x60\x60\n",
        )
        .await
        .unwrap();

        let expected = "<pre><span>\n</span>\nreturn 42;</pre>";
        let store = Store::load(directory.clone()).await.unwrap();
        assert_eq!(store.get(id).await.unwrap().content, expected);
        store
            .update(id, Some("Renamed".into()), None, None)
            .await
            .unwrap();
        let reopened = Store::load(directory.clone()).await.unwrap();
        assert_eq!(reopened.get(id).await.unwrap().content, expected);
        let older_tab = "<pre>\n\nreturn 7;</pre>";
        let edited = reopened
            .update(id, None, Some(older_tab.into()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(edited.content, "<pre><span>\n</span>\nreturn 7;</pre>");
        let reopened = Store::load(directory.clone()).await.unwrap();
        assert_eq!(reopened.get(id).await.unwrap().content, edited.content);
        fs::remove_dir_all(directory).await.unwrap();
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
    fn grapho_page_links_stay_relative() {
        // The editor stores a link to another document root-relative, so it
        // works on any host and port the library is served from.
        let clean = sanitize_content(
            "<p>See <a href=\"/doc/6f1c2f7a-58f7-4b1e-9f6d-8f1c2f7a58f7\">the plan</a>.</p>",
        );

        assert!(
            clean.contains("href=\"/doc/6f1c2f7a-58f7-4b1e-9f6d-8f1c2f7a58f7\""),
            "a root-relative page link survives: {clean}"
        );
        assert!(
            clean.contains("rel=\"noopener noreferrer\""),
            "the link still gets its hardening relation: {clean}"
        );
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
    fn a_preview_keeps_a_divider_as_a_rule() {
        assert_eq!(
            preview_html("<p>Above</p><hr><p>Below</p>"),
            "<p>Above</p><hr><p>Below</p>"
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
    async fn draft_save_requires_content_and_retries_use_the_same_file() {
        let directory = temp_directory("draft");
        let store = Store::load(directory.clone()).await.unwrap();
        let id = Uuid::new_v4();

        let blank = store
            .save_draft(
                id,
                Some(" Untitled   document ".to_owned()),
                Some("<p>&nbsp;<br></p><img src=\"https://example.test/image.png\">".to_owned()),
                Some(1180),
            )
            .await;
        assert!(matches!(blank, Err(StoreError::EmptyDraft)));
        assert!(store.list().await.is_empty());
        assert!(document_files(&directory).await.is_empty());

        // Dividers and embedded images both count as content without text.
        for content in ["<hr>", "<img src=\"data:image/png;base64,AA==\">"] {
            let draft_id = if content == "<hr>" {
                id
            } else {
                Uuid::new_v4()
            };
            let save = || store.save_draft(draft_id, None, Some(content.to_owned()), None);
            let (first, retry) = tokio::join!(save(), save());
            let first = first.unwrap().unwrap();
            let retry = retry.unwrap().unwrap();
            assert_eq!(first.id, draft_id);
            assert_eq!(first.content, content);
            assert_eq!(retry.id, first.id);
            assert_eq!(retry.updated_at, first.updated_at);
        }
        assert_eq!(document_files(&directory).await.len(), 2);

        assert!(store.delete(id).await.unwrap());
        assert!(store
            .save_draft(id, Some("Late save".to_owned()), None, None)
            .await
            .unwrap()
            .is_none());
        fs::remove_dir_all(directory).await.unwrap();
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
        assert!(reloaded
            .update(document.id, None, None, None)
            .await
            .unwrap()
            .is_none());
        assert!(reloaded.duplicate(document.id).await.unwrap().is_none());
        assert!(reloaded.list().await.is_empty());
        assert!(reloaded.search("field note").await.is_empty());
        assert_eq!(reloaded.usage().await.documents, 0);
        assert!(reloaded.usage().await.bytes > 0);

        drop(reloaded);
        let reloaded = Store::load(directory.clone()).await.expect("store reloads");
        let deleted = reloaded.list_deleted().await;
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].id, document.id);
        assert_eq!(deleted[0].title, "A field note");
        assert!(deleted[0].deleted_at > 0);
        assert!(reloaded.get(document.id).await.is_none());
        let restored = reloaded.restore(document.id).await.unwrap().unwrap();
        assert_eq!(restored.content, cleared.content);
        assert_eq!(restored.updated_at, cleared.updated_at);
        assert_eq!(restored.paper_width, cleared.paper_width);
        assert!(reloaded.list_deleted().await.is_empty());

        let _ = fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn duplicating_a_document_makes_a_separate_copy() {
        let directory = temp_directory("duplicate");
        let store = Store::load(directory.clone()).await.expect("store loads");

        let original = store.create().await.expect("document is created");
        let original = store
            .update(
                original.id,
                Some("A field note".to_owned()),
                Some("<p>Hello <strong>there</strong></p>".to_owned()),
                Some(1180),
            )
            .await
            .expect("update succeeds")
            .expect("document exists");

        let copy = store
            .duplicate(original.id)
            .await
            .expect("duplicate succeeds")
            .expect("the source exists");
        assert_ne!(copy.id, original.id, "a copy is a new document");
        assert_eq!(copy.title, "A field note (copy)");
        assert_eq!(copy.content, "<p>Hello <strong>there</strong></p>");
        assert_eq!(copy.paper_width, Some(1180));
        assert!(copy.created_at >= original.created_at);

        // The source keeps its own name and content.
        let source = store.get(original.id).await.expect("the source stays");
        assert_eq!(source.title, "A field note");
        assert_eq!(source.updated_at, original.updated_at);

        // The copy is part of the library and has its own file.
        assert_eq!(store.list().await.len(), 2);
        assert!(directory.join(format!("{}.md", copy.id)).exists());

        // Copying again numbers the title instead of stacking the suffix, and a
        // copy of a copy continues the same series.
        let second = store
            .duplicate(original.id)
            .await
            .expect("duplicate succeeds")
            .expect("the source exists");
        assert_eq!(second.title, "A field note (copy 2)");
        let third = store
            .duplicate(copy.id)
            .await
            .expect("duplicate succeeds")
            .expect("the copy exists");
        assert_eq!(third.title, "A field note (copy 3)");

        // Editing a copy does not touch the source or the other copies.
        let edited = store
            .update(copy.id, Some("A field note, edited".to_owned()), None, None)
            .await
            .expect("update succeeds")
            .expect("the copy exists");
        assert_eq!(edited.title, "A field note, edited");
        assert_eq!(
            store
                .get(original.id)
                .await
                .expect("the source stays")
                .title,
            "A field note"
        );
        assert_eq!(
            store.get(second.id).await.expect("the copy stays").title,
            "A field note (copy 2)"
        );

        // A document that is not there has nothing to copy.
        assert!(store
            .duplicate(Uuid::new_v4())
            .await
            .expect("duplicate succeeds")
            .is_none());

        drop(store);
        let reloaded = Store::load(directory.clone()).await.expect("store reloads");
        assert_eq!(reloaded.list().await.len(), 4);
        let restored = reloaded.get(copy.id).await.expect("the copy persists");
        assert_eq!(restored.content, "<p>Hello <b>there</b></p>");
        assert_eq!(restored.paper_width, Some(1180));

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
            assert!(old.join(format!("{id}.md")).exists());
            assert!(new.join(format!("{id}.md")).exists());
        }

        // Writes and deletes follow the store to the new folder.
        store
            .update(second.id, Some("After moving".to_owned()), None, None)
            .await
            .expect("update succeeds");
        let moved = fs::read_to_string(new.join(INDEX_FILE))
            .await
            .expect("the new file exists");
        assert!(moved.contains("After moving"));
        let left_behind = fs::read_to_string(old.join(INDEX_FILE))
            .await
            .expect("the old file stays");
        assert!(!left_behind.contains("After moving"));

        assert!(store.delete(first.id).await.expect("delete succeeds"));
        assert!(new.join(format!("{}.md", first.id)).exists());
        assert!(
            old.join(format!("{}.md", first.id)).exists(),
            "the old copy is never deleted"
        );

        store
            .relocate(old.clone())
            .await
            .expect("the library moves back");
        drop(store);
        let reloaded = Store::load(old.clone()).await.expect("store reloads");
        assert_eq!(reloaded.list().await.len(), 1);
        assert_eq!(reloaded.list_deleted().await[0].id, first.id);
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
        fs::write(occupied.join(format!("{stranger}.md")), b"{}")
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

        let content = fs::read_to_string(old.join(INDEX_FILE))
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
    async fn usage_counts_the_library_files_and_ignores_unrelated_files() {
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
        let size = fs::metadata(directory.join(format!("{}.md", document.id)))
            .await
            .unwrap()
            .len();
        let index_size = fs::metadata(directory.join(INDEX_FILE))
            .await
            .unwrap()
            .len();
        assert_eq!(usage.bytes, size + index_size);

        let _ = fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn markdown_and_shared_metadata_keep_layout_across_a_move() {
        let directory = temp_directory("markdown-layout");
        let target = temp_directory("markdown-layout-moved");
        let store = Store::load(directory.clone()).await.unwrap();
        let id = Uuid::new_v4();
        let content = concat!(
            "<h2>Notes</h2><p>One <b>important</b> thing.</p>",
            "<ul><li>Parent<ol><li>Nested</li></ol></li><li>Sibling</li></ul>",
            "<img alt=\"A diagram\" class=\"free\" width=\"40\" height=\"20\" ",
            "data-x=\"12\" data-y=\"8\" data-width=\"30\" data-radius=\"5\" ",
            "src=\"data:image/png;base64,AA==\">",
            "<img alt=\"Same image\" class=\"wrap-right\" src=\"data:image/png;base64,AA==\">",
            "<p data-align=\"center\">Caption</p><p></p>",
        );
        let saved = store
            .save_draft(
                id,
                Some("Document title".into()),
                Some(content.into()),
                Some(1180),
            )
            .await
            .unwrap()
            .unwrap();
        let body_path = directory.join(document_file_name(id));
        let body = fs::read_to_string(&body_path).await.unwrap();
        assert!(body.starts_with(
            "## Notes\n\nOne **important** thing.\n\n- Parent\n    1. Nested\n- Sibling\n"
        ));
        assert!(body.contains("![A diagram]("));
        assert!(body.contains("![Same image]("));
        assert!(!body.contains("base64"));
        assert!(!body.contains("Document title"));
        let index = read_index(&directory).await.unwrap();
        let metadata = &index.documents[&id];
        assert_eq!(metadata.images.len(), 1);
        let name = metadata.images.keys().next().unwrap();
        assert!(body.contains(name));
        assert_eq!(fs::read(directory.join(name)).await.unwrap(), [0]);

        store
            .update(id, Some("Renamed".into()), None, None)
            .await
            .unwrap();
        assert_eq!(fs::read_to_string(&body_path).await.unwrap(), body);
        store.relocate(target.clone()).await.unwrap();
        let reopened = Store::load(target.clone()).await.unwrap();
        let restored = reopened.get(id).await.unwrap();
        assert_eq!(restored.created_at, saved.created_at);
        assert_eq!(restored.title, "Renamed");
        assert_eq!(restored.paper_width, Some(1180));
        assert!(restored.content.contains("data-x=\"12\" data-y=\"8\""));
        assert!(restored
            .content
            .contains("data-width=\"30\" data-radius=\"5\""));
        assert!(restored.content.contains("class=\"wrap-right\""));
        assert!(restored
            .content
            .ends_with("<p data-align=\"center\">Caption</p><p></p>"));
        assert_eq!(
            restored
                .content
                .matches("data:image/png;base64,AA==")
                .count(),
            2
        );
        assert_eq!(reopened.search("important thing").await.len(), 1);

        fs::remove_dir_all(directory).await.unwrap();
        fs::remove_dir_all(target).await.unwrap();
    }

    #[tokio::test]
    async fn written_markdown_is_rolled_back_if_the_index_cannot_be_replaced() {
        let directory = temp_directory("index-retry");
        let store = Store::load(directory.clone()).await.unwrap();
        let document = store.create().await.unwrap();
        let blocked = directory.join(".metadata.json.tmp");
        fs::create_dir(&blocked).await.unwrap();
        let id = Uuid::new_v4();
        let create = || store.save_draft(id, Some("New".into()), Some("<p>New</p>".into()), None);
        assert!(create().await.is_err());
        assert!(!directory.join(document_file_name(id)).exists());
        assert!(store.get(id).await.is_none());
        assert!(store
            .update(document.id, None, Some("<p>Changed</p>".into()), None)
            .await
            .is_err());
        assert!(fs::read(directory.join(document_file_name(document.id)))
            .await
            .unwrap()
            .is_empty());
        assert_eq!(read_index(&directory).await.unwrap().documents.len(), 1);

        fs::remove_dir(blocked).await.unwrap();
        assert!(create().await.unwrap().is_some());
        fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn external_markdown_edits_are_read_and_sanitized_on_open() {
        let directory = temp_directory("manual-markdown");
        let store = Store::load(directory.clone()).await.unwrap();
        let document = store.create().await.unwrap();
        drop(store);
        fs::write(
            directory.join(document_file_name(document.id)),
            "# Edited\n\nA **new paragraph** with [a link](/doc/test#part).\n\n\
             ![Remote](https://example.com/cover.png)\n\n<p onclick=\"bad()\">Safe</p>\n",
        )
        .await
        .unwrap();
        let legacy = directory.join(format!("{}.json", Uuid::new_v4()));
        fs::write(&legacy, "legacy content").await.unwrap();
        let reopened = Store::load(directory.clone()).await.unwrap();
        let document = reopened.get(document.id).await.unwrap();
        assert!(document
            .content
            .starts_with("<h1>Edited</h1><p>A <b>new paragraph</b>"));
        assert!(document.content.contains("href=\"/doc/test#part\""));
        assert!(document.content.ends_with("<p>Safe</p>"));
        assert!(!document.content.contains("onclick"));
        assert!(!document.content.contains("https://example.com"));
        assert_eq!(reopened.list().await.len(), 1);
        assert_eq!(fs::read_to_string(legacy).await.unwrap(), "legacy content");
        fs::remove_dir_all(directory).await.unwrap();
    }
}
