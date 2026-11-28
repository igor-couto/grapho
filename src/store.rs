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
use tokio::task::JoinSet;
use uuid::Uuid;

use crate::markdown::{self, ImageAttributes};

mod drawing;
mod filenames;
mod markdown_files;
mod spaces;
use drawing::DrawingBody;
pub(crate) use drawing::DrawingData;
use filenames::{
    filename_key, has_suffix, valid_filename, FilenameSet, DRAWING_SUFFIX, MARKDOWN_SUFFIX,
};
use markdown_files::{FileStamp, MarkdownFile};
pub use spaces::{Space, SpaceError, SpaceSummary};

const SCHEMA_VERSION: u32 = 1;
const UUID_MARKDOWN_INDEX_VERSION: u32 = 1;
const INDEX_VERSION: u32 = 2;
const DEFAULT_TITLE: &str = "Untitled document";
const DEFAULT_BOARD_TITLE: &str = "Untitled board";
const DEFAULT_DRAWING_TITLE: &str = "Untitled drawing";
pub(crate) const INDEX_FILE: &str = "metadata.json";
/// The opt-in features the library can switch on. These are the only names the
/// Extensions dialog, the API, and the stored file accept.
pub(crate) const EXTENSION_NAMES: [&str; 2] = ["boards", "draw"];
/// The switches live beside the documents so every browser on this Grapho
/// server shares them, a restart keeps them, and moving the folder carries
/// them along.
const EXTENSIONS_FILE: &str = "extensions.json";
const SPELLING_WORDS_FILE: &str = "spelling-words.json";
/// The scope `spelling-words.json` uses for General, the unnamed Space every
/// document without a Space belongs to.
const SPELLING_GENERAL_SCOPE: &str = "general";
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

/// The custom words the spelling checker accepts, one list per Space.
///
/// Every Space, including General, has its own list. The lists share one file
/// so moving the data folder carries all of them, and a Space that uses the
/// main folder still keeps a dictionary of its own.
type SpellingWords = BTreeMap<String, BTreeSet<String>>;

/// The editor's document shape, served over the JSON API.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Document {
    #[serde(default = "schema_version")]
    pub version: u32,
    pub id: Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_id: Option<Uuid>,
    pub title: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub board_markdown: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    drawing: Option<DrawingBody>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paper_width: Option<u32>,
    pub created_at: u64,
    pub updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    deleted_at: Option<u64>,
    #[serde(skip)]
    markdown_file: Option<MarkdownFile>,
}

#[derive(Clone, Serialize, Deserialize)]
struct DocumentMetadata {
    title: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    board: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    drawing: bool,
    #[serde(default)]
    filename: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    space_id: Option<Uuid>,
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
    fn from_document(document: &Document, filename: String, images: ImageAttributes) -> Self {
        Self {
            title: document.title.clone(),
            board: document.board_markdown.is_some(),
            drawing: document.drawing.is_some(),
            filename,
            space_id: document.space_id,
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
            space_id: self.space_id,
            title: normalize_title(&self.title),
            created_at: self.created_at,
            updated_at: self.updated_at,
            paper_width: self.paper_width.map(bounded_paper_width),
            deleted_at: self.deleted_at,
            content,
            board_markdown: None,
            drawing: None,
            markdown_file: None,
        }
    }

    fn body_suffix(&self) -> &'static str {
        if self.drawing && has_suffix(&self.filename, DRAWING_SUFFIX) {
            DRAWING_SUFFIX
        } else {
            MARKDOWN_SUFFIX
        }
    }
}

pub(crate) enum DocumentKind {
    Text,
    Board,
    Drawing,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct LibraryIndex {
    version: u32,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    backup: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    spaces: BTreeMap<Uuid, Space>,
    documents: BTreeMap<Uuid, DocumentMetadata>,
}

impl Default for LibraryIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            backup: false,
            spaces: BTreeMap::new(),
            documents: BTreeMap::new(),
        }
    }
}

pub(crate) struct BackupSnapshot {
    pub known: HashSet<Uuid>,
    pub changed: HashSet<Uuid>,
    pub index_changed: bool,
    pub files: BTreeMap<String, Vec<u8>>,
    index: LibraryIndex,
}

impl BackupSnapshot {
    /// Keep anything outside the changed documents, including unrelated files.
    pub fn obsolete(&self, name: &str) -> bool {
        managed_file_id(name).is_some_and(|id| self.changed.contains(&id))
            && !self.files.contains_key(name)
    }

    pub fn index_bytes(&self, previous: Option<&LibraryIndex>) -> io::Result<Vec<u8>> {
        let Some(previous) = previous else {
            return index_bytes(&self.index);
        };
        let mut index = self.index.clone();
        // A save can commit while another document's backup is queued. Keep
        // the entries for bodies this batch has not copied yet, including a
        // legacy drawing whose new file has a different suffix.
        index.documents.retain(|id, entry| {
            if self.changed.contains(id) {
                return true;
            }
            if let Some(previous) = previous.documents.get(id) {
                entry.clone_from(previous);
                return true;
            }
            false
        });
        index_bytes(&index)
    }
}

impl Document {
    pub(crate) fn modified_at(&self) -> u64 {
        self.markdown_file
            .and_then(|file| file.stamp)
            .and_then(FileStamp::millis)
            .unwrap_or(self.updated_at)
    }

    pub(crate) fn file_revision(&self) -> Option<String> {
        self.markdown_file.map(MarkdownFile::revision)
    }

    fn check_revision(&self, expected: Option<&str>) -> Result<(), StoreError> {
        if let Some(expected) = expected {
            let matches = match self.markdown_file {
                Some(file) => expected == file.revision(),
                None => expected.is_empty(),
            };
            if !matches {
                return Err(StoreError::FileChanged);
            }
        }
        Ok(())
    }

    fn blank(id: Uuid) -> Self {
        let now = now_millis();
        Self {
            version: SCHEMA_VERSION,
            id,
            space_id: None,
            title: DEFAULT_TITLE.to_owned(),
            content: String::new(),
            board_markdown: None,
            drawing: None,
            paper_width: None,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            markdown_file: None,
        }
    }

    pub(crate) fn drawing_data(
        &self,
        version: Option<u32>,
    ) -> Result<Option<DrawingData>, StoreError> {
        self.drawing
            .as_ref()
            .map(|body| {
                let scene = body.scene(self.id).ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        "couldn't read the stored drawing scene",
                    )
                })?;
                DrawingData::for_client(scene, version)
            })
            .transpose()
    }
}

/// The compact shape used by the home page.
#[derive(Clone, Debug, Serialize)]
pub struct DocumentSummary {
    pub id: Uuid,
    pub space_id: Option<Uuid>,
    pub title: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub board: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub drawing: bool,
    pub excerpt: String,
    pub preview: String,
    pub word_count: usize,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Serialize)]
pub struct DeletedDocument {
    id: Uuid,
    space_id: Option<Uuid>,
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
    WrongDocumentFormat,
    InvalidDrawing,
    DrawingClientTooOld,
    NoBoardLayout,
    BoardImages,
    UnknownSpace,
    UnknownExtension,
    UnavailableSpace,
    FileChanged,
    Io(io::Error),
    Corrupt { path: PathBuf, message: String },
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyDraft => write!(f, "empty untitled draft"),
            Self::WrongDocumentFormat => write!(f, "document has another format"),
            Self::FileChanged => write!(f, "the document changed on disk"),
            Self::InvalidDrawing => write!(f, "invalid or unsupported drawing scene"),
            Self::DrawingClientTooOld => {
                write!(f, "drawing contains elements this client cannot edit")
            }
            Self::NoBoardLayout => write!(f, "document has no board columns"),
            Self::BoardImages => write!(f, "document has images a board cannot hold"),
            Self::UnknownSpace => write!(f, "space does not exist"),
            Self::UnknownExtension => write!(f, "extension does not exist"),
            Self::UnavailableSpace => write!(f, "the Space's storage folder is unavailable"),
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
            Self::EmptyDraft
            | Self::WrongDocumentFormat
            | Self::InvalidDrawing
            | Self::DrawingClientTooOld
            | Self::NoBoardLayout
            | Self::BoardImages
            | Self::UnknownSpace
            | Self::UnknownExtension
            | Self::UnavailableSpace
            | Self::FileChanged
            | Self::Corrupt { .. } => None,
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
    SpaceDirectory,
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
    extensions: BTreeSet<String>,
    unavailable_spaces: HashSet<Uuid>,
}

impl Store {
    pub async fn load(directory: PathBuf) -> Result<Self, StoreError> {
        fs::create_dir_all(&directory).await?;

        let mut index = read_index(&directory).await?;
        index.backup = false;
        // A malformed switch file only means every extension is off: a browser
        // preference must never keep the library from opening.
        let extensions = read_extensions(&directory).await.unwrap_or_default();
        let mut documents = HashMap::new();
        let mut folder_keys = HashSet::from([directory_key(&directory).await?]);
        let mut configured_paths = HashSet::from([directory.as_path()]);
        let mut dedicated_documents = BTreeMap::new();
        for (&space_id, space) in &index.spaces {
            if let Some(folder) = space.folder.as_deref() {
                if !folder.is_absolute() || !configured_paths.insert(folder) {
                    return Err(StoreError::Corrupt {
                        path: directory.join(INDEX_FILE),
                        message: format!("invalid or shared Space folder {}", folder.display()),
                    });
                }
                dedicated_documents.insert(space_id, Vec::new());
            }
        }

        for (&id, metadata) in &mut index.documents {
            if metadata
                .space_id
                .is_some_and(|space| !index.spaces.contains_key(&space))
            {
                metadata.space_id = None;
            }
            if let Some(entries) = metadata
                .space_id
                .and_then(|space| dedicated_documents.get_mut(&space))
            {
                entries.push((id, metadata.clone()));
            } else {
                documents.insert(id, load_document(&directory, id, metadata).await?);
            }
        }

        // Probe separate folders concurrently so startup does not wait through
        // each unreachable mount in turn.
        let mut loads = JoinSet::new();
        for (id, entries) in dedicated_documents {
            let folder = index.spaces[&id].folder.clone().expect("dedicated folder");
            loads.spawn(async move {
                let result = spaces::load_folder(&folder, entries).await;
                (id, folder, result)
            });
        }
        let mut unavailable_spaces = HashSet::new();
        while let Some(result) = loads.join_next().await {
            let (id, folder, result) = result.map_err(io::Error::other)?;
            match result {
                Ok((key, loaded)) => {
                    if !folder_keys.insert(key) {
                        return Err(StoreError::Corrupt {
                            path: directory.join(INDEX_FILE),
                            message: format!("shared Space folder {}", folder.display()),
                        });
                    }
                    for (document, metadata) in loaded {
                        index.documents.insert(document.id, metadata);
                        documents.insert(document.id, document);
                    }
                }
                Err(error) => {
                    eprintln!(
                        "could not load Space {} from {}: {error}",
                        index.spaces[&id].name,
                        folder.display()
                    );
                    unavailable_spaces.insert(id);
                }
            }
        }

        Ok(Self {
            state: RwLock::new(State {
                directory,
                documents,
                index,
                extensions,
                unavailable_spaces,
            }),
        })
    }

    /// The folder documents are written to right now.
    pub async fn directory(&self) -> PathBuf {
        self.state.read().await.directory.clone()
    }

    pub async fn directories(&self) -> Vec<PathBuf> {
        let state = self.state.read().await;
        std::iter::once(state.directory.clone())
            .chain(
                state
                    .index
                    .spaces
                    .values()
                    .filter_map(|space| space.folder.clone()),
            )
            .collect()
    }

    /// The words the spelling checker accepts in one Space's documents.
    pub async fn spelling_words(
        &self,
        space: Option<Uuid>,
    ) -> Result<BTreeSet<String>, StoreError> {
        let state = self.state.read().await;
        state.require_space(space)?;
        Ok(read_spelling_words(&state.directory)
            .await?
            .remove(&spelling_scope(space))
            .unwrap_or_default())
    }

    /// Add a word to one Space's dictionary and answer with that Space's words.
    pub async fn add_spelling_word(
        &self,
        space: Option<Uuid>,
        word: String,
    ) -> Result<BTreeSet<String>, StoreError> {
        let state = self.state.write().await;
        state.require_space(space)?;
        let scope = spelling_scope(space);
        let mut words = read_spelling_words(&state.directory).await?;
        if words.entry(scope.clone()).or_default().insert(word) {
            write_spelling_words(&state.directory, &words).await?;
        }
        Ok(words.remove(&scope).unwrap_or_default())
    }

    /// The extensions switched on for this Grapho server.
    pub async fn extensions(&self) -> BTreeSet<String> {
        self.state.read().await.extensions.clone()
    }

    /// Switch extensions on or off and answer with the full set. The change is
    /// on disk before it is acknowledged, so every browser and the next start
    /// see the same switches.
    pub async fn set_extensions(
        &self,
        changes: &BTreeMap<String, bool>,
    ) -> Result<BTreeSet<String>, StoreError> {
        if changes
            .keys()
            .any(|name| !EXTENSION_NAMES.contains(&name.as_str()))
        {
            return Err(StoreError::UnknownExtension);
        }

        let mut state = self.state.write().await;
        let mut extensions = state.extensions.clone();
        for (name, enabled) in changes {
            if *enabled {
                extensions.insert(name.clone());
            } else {
                extensions.remove(name);
            }
        }
        write_extensions(&state.directory, &extensions).await?;
        state.extensions = extensions.clone();
        Ok(extensions)
    }

    /// The live library across all of its folders, including deleted file bytes.
    pub async fn usage(&self) -> Usage {
        let state = self.state.read().await;
        let mut usage = Usage {
            bytes: file_size(&state.directory.join(INDEX_FILE)).await,
            ..Usage::default()
        };
        for metadata in state.index.documents.values() {
            usage.documents += usize::from(metadata.deleted_at.is_none());
            if !state.space_is_available(metadata.space_id) {
                continue;
            }
            let folder = state.folder_for(metadata.space_id);
            for name in document_files_for(metadata) {
                usage.bytes = usage
                    .bytes
                    .saturating_add(file_size(&folder.join(name)).await);
            }
        }
        usage
    }

    pub async fn list(&self) -> Vec<DocumentSummary> {
        let disk = self.scan_markdown(None, false).await;
        let state = self.state.read().await;
        let mut summaries: Vec<_> = state
            .documents
            .values()
            .filter(|document| document.deleted_at.is_none())
            .filter_map(|document| {
                let stamp = match disk.get(&document.id) {
                    Some(Some(file)) => Some(file.stamp),
                    Some(None) => return None,
                    None => None,
                };
                let mut summary = summary_for(document);
                if let Some(modified) = stamp.and_then(FileStamp::millis) {
                    summary.updated_at = modified;
                }
                Some(summary)
            })
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
                    space_id: document.space_id,
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

    pub async fn search(&self, query: &str, space: Option<Option<Uuid>>) -> Vec<DocumentMatch> {
        let query = fold_for_search(&query.split_whitespace().collect::<Vec<_>>().join(" "));
        if query.is_empty() {
            return Vec::new();
        }

        let disk = self.scan_markdown(space, true).await;
        let state = self.state.read().await;
        state
            .documents
            .values()
            .filter(|document| document.deleted_at.is_none() && in_space(document, space))
            .filter_map(|document| {
                let (document, stamp) = match disk.get(&document.id) {
                    Some(Some(file)) => {
                        (file.document.as_ref().unwrap_or(document), Some(file.stamp))
                    }
                    Some(None) => return None,
                    None => (document, None),
                };
                let text = html_to_text(&document.content);
                let title_match = search_excerpt(&document.title, &query);
                let body_match = search_excerpt(&text, &query);
                if title_match.is_none() && body_match.is_none() {
                    return None;
                }
                let mut summary = summarize(document, &text);
                if let Some(modified) = stamp.and_then(FileStamp::millis) {
                    summary.updated_at = modified;
                }
                Some(DocumentMatch {
                    summary,
                    title_match,
                    body_match,
                })
            })
            .collect()
    }

    #[cfg(test)]
    pub async fn get(&self, id: Uuid) -> Option<Document> {
        self.state.read().await.active_document(id).cloned()
    }

    pub async fn open(&self, id: Uuid) -> Result<Option<Document>, StoreError> {
        let (folder, mut metadata) = {
            let state = self.state.read().await;
            state.require_document_space(id)?;
            let Some((folder, metadata)) = state.tracked_markdown(id) else {
                return Ok(state.active_document(id).cloned());
            };
            if metadata.deleted_at.is_some() {
                return Ok(None);
            }
            (folder.to_owned(), metadata.clone())
        };
        markdown_files::load(&folder, id, &mut metadata, None).await
    }

    async fn scan_markdown(
        &self,
        space: Option<Option<Uuid>>,
        read_changed: bool,
    ) -> HashMap<Uuid, Option<markdown_files::ScannedFile>> {
        let mut folders = HashMap::<PathBuf, Vec<_>>::new();
        {
            let state = self.state.read().await;
            for document in state
                .documents
                .values()
                .filter(|doc| doc.deleted_at.is_none() && in_space(doc, space))
            {
                if let Some((folder, metadata)) = state.tracked_markdown(document.id) {
                    folders.entry(folder.to_owned()).or_default().push((
                        document.id,
                        metadata.clone(),
                        document.markdown_file.and_then(|file| file.stamp),
                    ));
                }
            }
        }
        let mut scans = JoinSet::new();
        for (folder, entries) in folders {
            scans.spawn(markdown_files::scan(folder, entries, read_changed));
        }
        let mut files = HashMap::new();
        while let Some(result) = scans.join_next().await {
            if let Ok(results) = result {
                files.extend(results);
            }
        }
        files
    }

    pub async fn require_document_space(&self, id: Uuid) -> Result<(), StoreError> {
        self.state.read().await.require_document_space(id)
    }

    pub async fn require_available_space(&self, id: Uuid) -> Result<(), StoreError> {
        self.state.read().await.require_available_space(Some(id))
    }

    pub async fn title(&self, id: Uuid) -> Option<String> {
        self.state
            .read()
            .await
            .active_document(id)
            .map(|doc| doc.title.clone())
    }

    pub(crate) async fn contains_active(&self, id: Uuid) -> bool {
        self.active_document_kind(id).await.is_some()
    }

    pub(crate) async fn active_document_kind(&self, id: Uuid) -> Option<DocumentKind> {
        self.state
            .read()
            .await
            .index
            .documents
            .get(&id)
            .filter(|document| document.deleted_at.is_none())
            .map(|document| {
                if document.drawing {
                    DocumentKind::Drawing
                } else if document.board {
                    DocumentKind::Board
                } else {
                    DocumentKind::Text
                }
            })
    }

    /// Read the files and index while they describe the same committed state.
    /// Connectors perform all network and destination I/O after this lock drops.
    pub(crate) async fn backup_snapshot(
        &self,
        ids: Option<&HashSet<Uuid>>,
    ) -> io::Result<BackupSnapshot> {
        let state = self.state.read().await;
        let mut index = state.index.clone();
        // Mirrors store all bodies together. Keep the groups, and let a
        // restored copy use its own folder until the owner chooses new paths.
        for space in index.spaces.values_mut() {
            space.folder = None;
        }
        index
            .documents
            .retain(|_, metadata| metadata.deleted_at.is_none());
        let known: HashSet<_> = index.documents.keys().copied().collect();
        let index_changed = ids.is_some_and(|ids| ids.contains(&Uuid::nil()));
        let changed: HashSet<_> = match ids {
            Some(ids) => ids
                .iter()
                .filter(|id| state.index.documents.contains_key(id))
                .copied()
                .collect(),
            None => known.clone(),
        };
        let mut files = BTreeMap::new();
        for id in changed.intersection(&known) {
            let metadata = &index.documents[id];
            if let Some(space) = metadata
                .space_id
                .filter(|id| state.unavailable_spaces.contains(id))
            {
                return Err(io::Error::other(format!(
                    "the storage folder for {} is unavailable",
                    state.index.spaces[&space].name
                )));
            }
            let folder = state.folder_for(metadata.space_id);
            for name in document_files_for(metadata) {
                let bytes = fs::read(folder.join(name)).await?;
                let mirror_name = if name == metadata.filename {
                    mirror_filename(*id, metadata.body_suffix())
                } else {
                    name.to_owned()
                };
                files.insert(mirror_name, bytes);
            }
        }
        index.backup = true;
        // Mirrors share a flat namespace. Stable body names let every
        // connector retry or remove copies by ID after a local rename.
        for (&id, metadata) in &mut index.documents {
            metadata.filename = mirror_filename(id, metadata.body_suffix());
        }
        Ok(BackupSnapshot {
            known,
            changed,
            index_changed,
            files,
            index,
        })
    }

    #[cfg(test)]
    pub async fn create(&self) -> Result<Document, StoreError> {
        self.create_in_space(None).await
    }

    pub async fn create_in_space(&self, space_id: Option<Uuid>) -> Result<Document, StoreError> {
        let mut state = self.state.write().await;
        state.require_space(space_id)?;
        let mut document = Document::blank(Uuid::new_v4());
        document.space_id = space_id;

        state.persist(document).await
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
        state.require_document_space(id)?;
        state.refresh_markdown(id).await?;
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
        let mut document = Document {
            version: SCHEMA_VERSION,
            id: Uuid::new_v4(),
            space_id: source.space_id,
            title,
            content: source.content,
            board_markdown: source.board_markdown,
            drawing: source
                .drawing
                .map(|body| body.into_native(id))
                .transpose()?,
            paper_width: source.paper_width,
            created_at: now,
            updated_at: now,
            deleted_at: None,
            markdown_file: None,
        };
        synchronize_board_heading(&mut document);

        state.persist(document).await.map(Some)
    }

    /// Apply a partial update. Sanitisation and title normalisation happen here,
    /// at the trust boundary, rather than in the browser.
    #[cfg(test)]
    pub async fn update(
        &self,
        id: Uuid,
        title: Option<String>,
        content: Option<String>,
        paper_width: Option<u32>,
    ) -> Result<Option<Document>, StoreError> {
        self.save(id, title, content, paper_width, None, None).await
    }

    /// A draft already has an id, so a retry of the first save updates the
    /// same file even if the first response never reached the editor.
    #[cfg(test)]
    pub async fn save_draft(
        &self,
        id: Uuid,
        title: Option<String>,
        content: Option<String>,
        paper_width: Option<u32>,
    ) -> Result<Option<Document>, StoreError> {
        self.save_draft_in_space(id, title, content, paper_width, None)
            .await
    }

    #[cfg(test)]
    pub async fn save_draft_in_space(
        &self,
        id: Uuid,
        title: Option<String>,
        content: Option<String>,
        paper_width: Option<u32>,
        space_id: Option<Uuid>,
    ) -> Result<Option<Document>, StoreError> {
        self.save(id, title, content, paper_width, Some(space_id), None)
            .await
    }

    pub async fn save_board(
        &self,
        id: Uuid,
        source: String,
        draft_space: Option<Option<Uuid>>,
        expected_revision: &str,
    ) -> Result<Option<Document>, StoreError> {
        let mut state = self.state.write().await;
        state.require_document_space(id)?;
        state.refresh_markdown(id).await?;
        let mut document = match state.documents.get(&id) {
            Some(document) if document.deleted_at.is_some() => return Ok(None),
            Some(document) => {
                let Some(previous) = &document.board_markdown else {
                    return Err(StoreError::WrongDocumentFormat);
                };
                if previous == &source {
                    return Ok(Some(document.clone()));
                }
                document.check_revision(Some(expected_revision))?;
                let mut document = document.clone();
                document.updated_at = now_millis().max(document.updated_at.saturating_add(1));
                document
            }
            None => {
                let Some(space_id) = draft_space else {
                    return Ok(None);
                };
                state.require_space(space_id)?;
                if source.trim().is_empty() {
                    return Err(StoreError::EmptyDraft);
                }
                let mut document = Document::blank(id);
                document.space_id = space_id;
                document
            }
        };
        document.title = board_heading(&source)
            .map(|(_, _, heading)| html_to_text(&board_html(&format!("# {heading}"))))
            .filter(|title| !title.is_empty())
            .map_or_else(
                || DEFAULT_BOARD_TITLE.to_owned(),
                |title| normalize_title(&title),
            );
        document.content = board_html(&source);
        document.board_markdown = Some(source);
        state.persist(document).await.map(Some)
    }

    /// Adopt a regular document's Markdown as board source.
    ///
    /// The writing is kept verbatim: it is already the file a board saves, so
    /// conversion only reads the structure to decide whether a board can show
    /// it. Images block the conversion because a board has no way to paint them
    /// and the board body's index entry drops the attachments. An existing board
    /// is left alone, which makes a repeated request harmless.
    pub async fn convert_to_board(&self, id: Uuid) -> Result<Option<Document>, StoreError> {
        let mut state = self.state.write().await;
        state.require_document_space(id)?;
        state.refresh_markdown(id).await?;
        let Some(document) = state.active_document(id).cloned() else {
            return Ok(None);
        };
        if document.board_markdown.is_some() {
            return Ok(Some(document));
        }
        if document.drawing.is_some() {
            return Err(StoreError::WrongDocumentFormat);
        }
        let metadata = state.index.documents[&id].clone();
        if !metadata.images.is_empty() {
            return Err(StoreError::BoardImages);
        }
        let folder = state.folder_for(document.space_id).to_path_buf();
        let source = fs::read_to_string(folder.join(&metadata.filename)).await?;
        if !board_layout(&source) {
            return Err(StoreError::NoBoardLayout);
        }

        let mut document = document;
        document.updated_at = now_millis().max(document.updated_at.saturating_add(1));
        document.board_markdown = Some(source);
        synchronize_board_heading(&mut document);
        state.persist(document).await.map(Some)
    }

    pub(crate) async fn save_drawing(
        &self,
        id: Uuid,
        title: &str,
        data: DrawingData,
        draft_space: Option<Option<Uuid>>,
    ) -> Result<Option<String>, StoreError> {
        let title = normalize_title_or(title, DEFAULT_DRAWING_TITLE);
        let mut state = self.state.write().await;
        state.require_document_space(id)?;
        let (mut document, previous) = match state.documents.get(&id) {
            Some(document) if document.deleted_at.is_some() => return Ok(None),
            Some(document) => {
                let body = document
                    .drawing
                    .as_ref()
                    .ok_or(StoreError::WrongDocumentFormat)?;
                let previous = body.scene(id).ok_or(StoreError::InvalidDrawing)?;
                (document.clone(), Some(previous))
            }
            None => {
                let Some(space_id) = draft_space else {
                    return Ok(None);
                };
                state.require_space(space_id)?;
                let mut document = Document::blank(id);
                document.space_id = space_id;
                (document, None)
            }
        };

        let scene = data.into_scene(previous)?;
        if !scene.is_valid() {
            return Err(StoreError::InvalidDrawing);
        }
        if document.drawing.is_none() && title == DEFAULT_DRAWING_TITLE && scene.is_empty() {
            return Err(StoreError::EmptyDraft);
        }
        let body = DrawingBody::from_scene(&scene)?;
        if document.drawing.as_ref() == Some(&body) && document.title == title {
            return Ok(Some(title));
        }
        if document.drawing.is_some() {
            document.updated_at = now_millis().max(document.updated_at.saturating_add(1));
        }
        document.title.clone_from(&title);
        document.drawing = Some(body);
        state.persist(document).await?;
        Ok(Some(title))
    }

    pub(crate) async fn save(
        &self,
        id: Uuid,
        title: Option<String>,
        content: Option<String>,
        paper_width: Option<u32>,
        draft_space: Option<Option<Uuid>>,
        expected_revision: Option<&str>,
    ) -> Result<Option<Document>, StoreError> {
        let mut state = self.state.write().await;
        state.require_document_space(id)?;
        state.refresh_markdown(id).await?;
        let (mut document, creating) = match state.documents.get(&id) {
            Some(document) if document.deleted_at.is_none() => (document.clone(), false),
            None if draft_space.is_some() => {
                let mut document = Document::blank(id);
                document.space_id = draft_space.flatten();
                state.require_space(document.space_id)?;
                (document, true)
            }
            _ => return Ok(None),
        };

        if (document.board_markdown.is_some() || document.drawing.is_some()) && content.is_some() {
            return Err(StoreError::WrongDocumentFormat);
        }

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
            document.check_revision(expected_revision)?;
            document.updated_at = now_millis().max(document.updated_at.saturating_add(1));
        }

        document.version = SCHEMA_VERSION;
        let renamed = document.title != next_title;
        document.title = next_title;
        document.content = next_content;
        document.paper_width = next_paper_width;
        if renamed {
            synchronize_board_heading(&mut document);
        }

        state.persist(document).await.map(Some)
    }

    pub async fn delete(&self, id: Uuid) -> Result<bool, StoreError> {
        let mut state = self.state.write().await;
        state.require_document_space(id)?;
        let Some(mut document) = state.active_document(id).cloned() else {
            return Ok(false);
        };

        document.deleted_at = Some(now_millis());
        state.persist(document).await?;
        Ok(true)
    }

    pub async fn restore(&self, id: Uuid) -> Result<Option<Document>, StoreError> {
        let mut state = self.state.write().await;
        state.require_document_space(id)?;
        let Some(mut document) = state.documents.get(&id).cloned() else {
            return Ok(None);
        };
        if document.deleted_at.take().is_some() {
            return state.persist(document).await.map(Some);
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
        let target_key = directory_key(&target)
            .await
            .map_err(|error| RelocateError::io(&target, error))?;
        if current_key == target_key {
            return Err(RelocateError::SameDirectory);
        }
        state
            .check_space_folders(&target, &target_key, None)
            .await?;

        fs::create_dir_all(&target)
            .await
            .map_err(|error| RelocateError::io(&target, error))?;

        let target_index = read_index(&target)
            .await
            .map_err(|error| RelocateError::io(&target, error))?;
        let strangers = target_index
            .documents
            .keys()
            .filter(|id| !state.index.documents.contains_key(id))
            .count();
        if strangers > 0 {
            return Err(RelocateError::Occupied {
                documents: strangers,
            });
        }
        // A library with dedicated Space folders can have an index and no
        // local Markdown files. Protect that index just like its bodies.
        if target_index
            .spaces
            .keys()
            .any(|id| !state.index.spaces.contains_key(id))
        {
            return Err(RelocateError::SpaceDirectory);
        }

        let spelling_words = read_spelling_words(&state.directory)
            .await
            .map_err(|error| RelocateError::io(&state.directory, error))?;

        // Copies this call creates are the only ones a failure may remove; a
        // file that was already there belongs to the folder's previous use.
        let mut created = Vec::new();
        let mut index = state.index.clone();
        let copy = async {
            let mut filenames = FilenameSet::read(&target).await?;
            for (&id, metadata) in &mut index.documents {
                if state.folder_for(metadata.space_id) != state.directory {
                    continue;
                }
                let owned = target_index
                    .documents
                    .get(&id)
                    .filter(|entry| {
                        folder_for(&target, &target_index.spaces, entry.space_id) == target
                    })
                    .map(|entry| entry.filename.as_str());
                let filename = filenames
                    .claim(
                        &metadata.title,
                        metadata.body_suffix(),
                        Some(&metadata.filename),
                        owned,
                    )
                    .await?;
                copy_document_files(
                    metadata,
                    &filename,
                    &state.directory,
                    &target,
                    owned == Some(&filename),
                    &mut created,
                )
                .await?;
                metadata.filename = filename;
            }
            Ok::<_, io::Error>(())
        };
        if let Err(error) = copy.await {
            remove_copies(&created).await;
            return Err(RelocateError::io(&target, error));
        }

        // When returning to a previous data folder, retain any words added there.
        if !spelling_words.is_empty() {
            let copied = async {
                let mut words = read_spelling_words(&target).await?;
                for (scope, added) in &spelling_words {
                    words
                        .entry(scope.clone())
                        .or_default()
                        .extend(added.iter().cloned());
                }
                write_spelling_words(&target, &words).await
            }
            .await;
            if let Err(error) = copied {
                remove_copies(&created).await;
                return Err(RelocateError::io(&target, error));
            }
        }

        // The switches belong to the server, not the folder, so the folder the
        // server moves to now records the current answer.
        if let Err(error) = write_extensions(&target, &state.extensions).await {
            remove_copies(&created).await;
            return Err(RelocateError::io(&target, error));
        }

        let write =
            async { write_data_file(&target.join(INDEX_FILE), &index_bytes(&index)?).await };
        if let Err(error) = write.await {
            remove_copies(&created).await;
            return Err(RelocateError::io(&target, error));
        }

        for metadata in target_index.documents.values() {
            if folder_for(&target, &target_index.spaces, metadata.space_id) == target
                && !index.documents.values().any(|entry| {
                    state.folder_for(entry.space_id) == state.directory
                        && filename_key(&entry.filename) == filename_key(&metadata.filename)
                })
            {
                remove_old_body(&target, &metadata.filename).await;
            }
        }
        state.directory = target.clone();
        state.index = index;
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

/// The scope key a Space's words are stored under.
fn spelling_scope(space: Option<Uuid>) -> String {
    space.map_or_else(|| SPELLING_GENERAL_SCOPE.to_owned(), |id| id.to_string())
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredSpellingWords {
    /// The first version of the file kept one list for the whole library.
    Library(BTreeSet<String>),
    Spaces(BTreeMap<String, BTreeSet<String>>),
}

async fn read_spelling_words(directory: &Path) -> io::Result<SpellingWords> {
    match fs::read(directory.join(SPELLING_WORDS_FILE)).await {
        Ok(bytes) => match serde_json::from_slice(&bytes)? {
            StoredSpellingWords::Library(words) => {
                Ok(BTreeMap::from([(spelling_scope(None), words)]))
            }
            StoredSpellingWords::Spaces(words) => Ok(words),
        },
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(SpellingWords::new()),
        Err(error) => Err(error),
    }
}

async fn write_spelling_words(directory: &Path, words: &SpellingWords) -> io::Result<()> {
    let mut words = words.clone();
    words.retain(|_, words| !words.is_empty());
    crate::settings::write_json(&directory.join(SPELLING_WORDS_FILE), &words).await
}

async fn read_extensions(directory: &Path) -> io::Result<BTreeSet<String>> {
    match fs::read(directory.join(EXTENSIONS_FILE)).await {
        Ok(bytes) => {
            let names: Vec<String> = serde_json::from_slice(&bytes)?;
            // A file written by a newer Grapho may carry a feature this build
            // does not have. Keep only the names both know.
            Ok(names
                .into_iter()
                .filter(|name| EXTENSION_NAMES.contains(&name.as_str()))
                .collect())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(BTreeSet::new()),
        Err(error) => Err(error),
    }
}

async fn write_extensions(directory: &Path, extensions: &BTreeSet<String>) -> io::Result<()> {
    // The dialog's order, so the small file stays stable and easy to read.
    let names: Vec<&str> = EXTENSION_NAMES
        .iter()
        .copied()
        .filter(|name| extensions.contains(*name))
        .collect();
    crate::settings::write_json(&directory.join(EXTENSIONS_FILE), &names).await
}

fn in_space(document: &Document, space: Option<Option<Uuid>>) -> bool {
    space.is_none_or(|id| document.space_id == id)
}

fn board_html(source: &str) -> String {
    sanitize_document_content(markdown::decode(source, &BTreeMap::new(), &BTreeMap::new()))
}

/// Whether this Markdown reads as a board the board page can lay out.
///
/// The browser's board parser reads `#` as the title, `##` as a column and `-`
/// as a card, and it skips everything inside a code fence. Conversion needs the
/// same answer, so this scan follows those line rules rather than rendering the
/// Markdown: a document becomes a board only when at least one `##` column
/// heading is waiting outside the fences. Without one there is no board to show.
fn board_layout(source: &str) -> bool {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let mut fence = None;
    for line in source.split(['\n', '\r']) {
        if let Some(marker) = fence {
            if closes_fence(line, marker) {
                fence = None;
            }
            continue;
        }
        match opening_fence(line) {
            Some(marker) => fence = Some(marker),
            None if column_heading(line) => return true,
            None => {}
        }
    }
    false
}

/// The opening of a fenced code block, as the board page sees it: at least three
/// backticks with no further backtick after them.
fn opening_fence(line: &str) -> Option<usize> {
    let line = line.trim();
    let ticks = line.bytes().take_while(|&byte| byte == b'`').count();
    (ticks >= 3 && !line[ticks..].contains('`')).then_some(ticks)
}

fn closes_fence(line: &str, marker: usize) -> bool {
    let line = line.trim();
    line.len() >= marker && line.bytes().all(|byte| byte == b'`')
}

/// A `##` heading with a title, which the board parser turns into a column.
fn column_heading(line: &str) -> bool {
    let hashes = line.bytes().take_while(|&byte| byte == b'#').count();
    hashes == 2 && line[2..].starts_with([' ', '\t']) && !line[2..].trim().is_empty()
}

fn board_heading(source: &str) -> Option<(usize, usize, &str)> {
    let mut start = source.len() - source.trim_start_matches('\u{feff}').len();
    for line in source[start..].split_inclusive(['\r', '\n']) {
        let text = line.trim_end_matches(['\r', '\n']);
        if text.trim().is_empty() {
            start += line.len();
            continue;
        }
        let heading = text.strip_prefix('#')?.strip_prefix([' ', '\t'])?;
        return Some((start, start + text.len(), heading.trim()));
    }
    None
}

fn synchronize_board_heading(document: &mut Document) {
    if let Some(source) = &mut document.board_markdown {
        let heading = format!("# {}", markdown::escape_markdown(&document.title));
        match board_heading(source) {
            Some((start, end, _)) => source.replace_range(start..end, &heading),
            None => {
                let start = source.len() - source.trim_start_matches('\u{feff}').len();
                source.insert_str(start, &format!("{heading}\n\n"));
            }
        }
        document.content = board_html(source);
    }
}

impl State {
    fn tracked_markdown(&self, id: Uuid) -> Option<(&Path, &DocumentMetadata)> {
        let metadata = self.index.documents.get(&id)?;
        let folder = self
            .index
            .spaces
            .get(&metadata.space_id?)?
            .folder
            .as_deref()?;
        (!metadata.drawing).then_some((folder, metadata))
    }

    async fn refresh_markdown(&mut self, id: Uuid) -> Result<(), StoreError> {
        let Some((folder, metadata)) = self.tracked_markdown(id) else {
            return Ok(());
        };
        if metadata.deleted_at.is_none() {
            let document =
                markdown_files::load(folder, id, &mut metadata.clone(), self.documents.get(&id))
                    .await?
                    .ok_or(StoreError::FileChanged)?;
            self.documents.insert(id, document);
        }
        Ok(())
    }

    fn active_document(&self, id: Uuid) -> Option<&Document> {
        self.documents
            .get(&id)
            .filter(|doc| doc.deleted_at.is_none())
    }

    async fn persist(&mut self, mut document: Document) -> Result<Document, StoreError> {
        self.require_available_space(document.space_id)?;
        let id = document.id;
        let folder = self.folder_for(document.space_id).to_path_buf();
        let track_markdown = document.drawing.is_none() && folder != self.directory;
        let old_file = self
            .documents
            .get(&id)
            .and_then(|doc| doc.markdown_file)
            .filter(|_| track_markdown);
        let old_metadata = self.index.documents.get(&id);
        let old_name = old_metadata.map(|metadata| metadata.filename.as_str());
        let suffix = document
            .drawing
            .as_ref()
            .map_or(MARKDOWN_SUFFIX, DrawingBody::suffix);
        let filename = match old_metadata {
            Some(old)
                if old.title == document.title
                    && old.body_suffix() == suffix
                    && old.filename != mirror_filename(id, suffix) =>
            {
                old.filename.clone()
            }
            _ => {
                FilenameSet::read(&folder)
                    .await?
                    .claim(&document.title, suffix, None, old_name)
                    .await?
            }
        };
        let new_path = old_name != Some(&filename);
        let path = folder.join(&filename);
        let previous_path = old_name.map(|name| folder.join(name));
        let mut created = Vec::new();
        let mut old_body = None;
        let body_changed = self.documents.get(&id).is_none_or(|old| {
            old.board_markdown != document.board_markdown
                || old.drawing != document.drawing
                || old.content != document.content
        });
        let image_attributes = if body_changed {
            let stored_source = document
                .board_markdown
                .as_deref()
                .or_else(|| document.drawing.as_ref().map(DrawingBody::source));
            let (source, images, attributes) = match stored_source {
                Some(source) => (
                    Cow::Borrowed(source),
                    BTreeMap::new(),
                    ImageAttributes::new(),
                ),
                None => {
                    let body = markdown::encode(id, &document.content);
                    (
                        Cow::Owned(body.markdown),
                        body.images,
                        body.image_attributes,
                    )
                }
            };
            if !new_path && old_file.is_none() {
                old_body = Some(fs::read(&path).await?);
            }
            let write = async {
                for (name, bytes) in images {
                    let image = folder.join(name);
                    if !fs::symlink_metadata(&image)
                        .await
                        .is_ok_and(|file| file.is_file())
                    {
                        write_data_file(&image, &bytes).await?;
                        created.push(image);
                    }
                }
                if new_path {
                    if let (Some(previous), Some(expected)) = (&previous_path, old_file) {
                        markdown_files::checked_bytes(previous, expected).await?;
                    }
                    write_new_data_file(&path, source.as_bytes()).await?;
                    created.push(path.clone());
                } else if let Some(expected) = old_file {
                    let (previous, stamp) =
                        replace_markdown(&path, source.as_bytes(), expected).await?;
                    old_body = Some(previous);
                    document.markdown_file =
                        Some(MarkdownFile::new(source.as_bytes(), Some(stamp)));
                } else {
                    write_data_file(&path, source.as_bytes()).await?;
                }
                if track_markdown && new_path {
                    document.markdown_file = Some(markdown_version(&path, source.as_bytes()).await);
                }
                Ok::<_, StoreError>(())
            };
            if let Err(error) = write.await {
                remove_copies(&created).await;
                return Err(error);
            }
            attributes
        } else {
            if new_path {
                let previous = previous_path
                    .as_deref()
                    .expect("unchanged document has a body");
                let bytes = match old_file {
                    Some(expected) => markdown_files::checked_bytes(previous, expected).await?,
                    None => fs::read(previous).await?,
                };
                write_new_data_file(&path, &bytes).await?;
                created.push(path.clone());
                if track_markdown {
                    document.markdown_file = Some(markdown_version(&path, &bytes).await);
                }
            }
            old_metadata.map_or_else(ImageAttributes::new, |old| old.images.clone())
        };

        let metadata = DocumentMetadata::from_document(&document, filename, image_attributes);
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
            if let Some(bytes) = old_body {
                let rollback = match document.markdown_file {
                    Some(written) => replace_markdown(&path, &bytes, written).await.map(|_| ()),
                    None => write_data_file(&path, &bytes)
                        .await
                        .map_err(StoreError::from),
                };
                if let Err(rollback) = rollback {
                    eprintln!("could not roll back document save for {id}: {rollback}");
                    return Err(error.into());
                }
            }
            remove_copies(&created).await;
            return Err(error.into());
        }

        if let Some(previous) = previous {
            let current = &self.index.documents[&id];
            if new_path {
                // Leave a copy if an external writer edited the old name while
                // Grapho was committing the renamed document.
                let safe_to_remove = match old_file {
                    Some(expected) => {
                        markdown_files::checked_bytes(&folder.join(&previous.filename), expected)
                            .await
                            .is_ok()
                    }
                    None => true,
                };
                if safe_to_remove {
                    remove_old_body(&folder, &previous.filename).await;
                }
            }
            for name in previous
                .images
                .keys()
                .filter(|name| !current.images.contains_key(*name))
            {
                let _ = fs::remove_file(folder.join(name)).await;
            }
        }
        self.documents.insert(id, document.clone());
        Ok(document)
    }
}

async fn load_document(
    folder: &Path,
    id: Uuid,
    metadata: &mut DocumentMetadata,
) -> Result<Document, StoreError> {
    let path = folder.join(&metadata.filename);
    let source = fs::read_to_string(&path)
        .await
        .map_err(|error| StoreError::Corrupt {
            path,
            message: format!("could not read the document's body file: {error}"),
        })?;
    decode_document(folder, id, metadata, source).await
}

async fn decode_document(
    folder: &Path,
    id: Uuid,
    metadata: &mut DocumentMetadata,
    source: String,
) -> Result<Document, StoreError> {
    if metadata.drawing {
        let mut document = metadata.document(id, String::new());
        document.drawing = Some(if metadata.body_suffix() == DRAWING_SUFFIX {
            DrawingBody::Json(source)
        } else {
            DrawingBody::LegacyMarkdown(source)
        });
        return Ok(document);
    }
    if metadata.board {
        let mut document = metadata.document(id, board_html(&source));
        document.board_markdown = Some(source);
        return Ok(document);
    }
    let mut images = BTreeMap::new();
    for name in metadata.images.keys().filter(|name| source.contains(*name)) {
        match fs::read(folder.join(name)).await {
            Ok(bytes) => {
                images.insert(name.clone(), bytes);
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    metadata.images.retain(|name, _| images.contains_key(name));
    let content = sanitize_document_content(markdown::decode(&source, &images, &metadata.images));
    Ok(metadata.document(id, content))
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
    if index.version == UUID_MARKDOWN_INDEX_VERSION {
        return read_uuid_markdown_index(directory, index.documents).await;
    }
    if index.version != INDEX_VERSION {
        return Err(StoreError::Corrupt {
            path,
            message: format!("unsupported metadata index version {}", index.version),
        });
    }
    let mut filenames = HashSet::new();
    for (&id, metadata) in &index.documents {
        let folder = folder_for(directory, &index.spaces, metadata.space_id);
        if !valid_filename(&metadata.filename, metadata.body_suffix())
            || (metadata.drawing && metadata.board)
            || !filenames.insert((folder, filename_key(&metadata.filename)))
            || metadata
                .images
                .keys()
                .any(|name| markdown::attachment_owner(name) != Some(id))
        {
            return Err(StoreError::Corrupt {
                path,
                message: format!("invalid or duplicate filename for document {id}"),
            });
        }
    }
    Ok(index)
}

// Version 1 discovered bodies and attachments by UUID. Keep that behavior
// when opening those libraries and write the new index on the next mutation.
async fn read_uuid_markdown_index(
    directory: &Path,
    mut previous: BTreeMap<Uuid, DocumentMetadata>,
) -> Result<LibraryIndex, StoreError> {
    let mut index = LibraryIndex::default();
    let mut attachments: HashMap<Uuid, Vec<String>> = HashMap::new();
    let mut entries = fs::read_dir(directory).await?;
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_file() {
            continue;
        }
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if let Some(id) = name
            .strip_suffix(MARKDOWN_SUFFIX)
            .and_then(canonical_document_id)
        {
            let mut metadata = previous.remove(&id).unwrap_or_else(|| {
                DocumentMetadata::from_document(
                    &Document::blank(id),
                    String::new(),
                    ImageAttributes::new(),
                )
            });
            metadata.filename = name;
            metadata.space_id = None;
            metadata.board = false;
            metadata.drawing = false;
            index.documents.insert(id, metadata);
        } else if let Some(id) = markdown::attachment_owner(&name) {
            attachments.entry(id).or_default().push(name);
        }
    }

    for (id, metadata) in &mut index.documents {
        let mut placements = std::mem::take(&mut metadata.images);
        for name in attachments.remove(id).into_iter().flatten() {
            let placement = placements.remove(&name).unwrap_or_default();
            metadata.images.insert(name, placement);
        }
    }
    Ok(index)
}

fn folder_for<'a>(
    directory: &'a Path,
    spaces: &'a BTreeMap<Uuid, Space>,
    space_id: Option<Uuid>,
) -> &'a Path {
    space_id
        .and_then(|id| spaces.get(&id)?.folder.as_deref())
        .unwrap_or(directory)
}

pub(crate) fn parse_backup_index(bytes: &[u8]) -> Option<LibraryIndex> {
    let index: LibraryIndex = serde_json::from_slice(bytes).ok()?;
    (index.version == INDEX_VERSION && index.backup).then_some(index)
}

fn index_bytes(index: &LibraryIndex) -> io::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec_pretty(index)?;
    bytes.push(b'\n');
    Ok(bytes)
}

async fn copy_document_files(
    metadata: &DocumentMetadata,
    filename: &str,
    source: &Path,
    target: &Path,
    replace_body: bool,
    created: &mut Vec<PathBuf>,
) -> io::Result<()> {
    for name in metadata.images.keys() {
        let destination = target.join(name);
        let bytes = fs::read(source.join(name)).await?;
        match write_new_data_file(&destination, &bytes).await {
            Ok(()) => created.push(destination),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                if !fs::symlink_metadata(&destination).await?.is_file()
                    || fs::read(&destination).await? != bytes
                {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
    let destination = target.join(filename);
    let body = fs::read(source.join(&metadata.filename)).await?;
    if replace_body
        && fs::symlink_metadata(&destination)
            .await
            .is_ok_and(|file| file.is_file())
    {
        write_data_file(&destination, &body).await?;
    } else {
        write_new_data_file(&destination, &body).await?;
        created.push(destination);
    }
    Ok(())
}

async fn remove_old_body(folder: &Path, name: &str) {
    if let Err(error) = fs::remove_file(folder.join(name)).await {
        if error.kind() != io::ErrorKind::NotFound {
            eprintln!("could not remove previous copy of {name}: {error}");
        }
    }
}

async fn file_size(path: &Path) -> u64 {
    fs::metadata(path).await.map_or(0, |file| file.len())
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

/// Backup bodies use UUID names so the connectors can recognize old copies.
pub(crate) fn mirror_document_id(path: &Path) -> Option<Uuid> {
    let name = path.file_name()?.to_str()?;
    let stem = name
        .strip_suffix(MARKDOWN_SUFFIX)
        .or_else(|| name.strip_suffix(DRAWING_SUFFIX))?;
    canonical_document_id(stem)
}

fn canonical_document_id(stem: &str) -> Option<Uuid> {
    let id = Uuid::parse_str(stem).ok()?;
    (id.to_string() == stem).then_some(id)
}

pub(crate) fn managed_file_id(name: &str) -> Option<Uuid> {
    let path = Path::new(name);
    if path.file_name()?.to_str()? != name {
        return None;
    }
    mirror_document_id(path).or_else(|| markdown::attachment_owner(name))
}

fn mirror_filename(id: Uuid, suffix: &str) -> String {
    format!("{id}{suffix}")
}

fn document_files_for(metadata: &DocumentMetadata) -> impl Iterator<Item = &str> {
    metadata
        .images
        .keys()
        .map(String::as_str)
        .chain(std::iter::once(metadata.filename.as_str()))
}

/// An unindexed body can be written directly. A failed write leaves the
/// previous index usable and never replaces a file already at this path.
async fn write_new_data_file(destination: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::File::create_new(destination).await?;
    let result = async {
        file.write_all(bytes).await?;
        file.sync_all().await
    }
    .await;
    drop(file);
    if result.is_err() {
        let _ = fs::remove_file(destination).await;
    }
    result
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
    normalize_title_or(raw, DEFAULT_TITLE)
}

fn normalize_title_or(raw: &str, default: &str) -> String {
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
        default.to_owned()
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
        "table",
        "tbody",
        "td",
        "th",
        "thead",
        "tr",
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
        "br" | "img"
            | "hr"
            | "p"
            | "div"
            | "h1"
            | "h2"
            | "h3"
            | "li"
            | "blockquote"
            | "pre"
            | "table"
            | "tr"
            | "th"
            | "td"
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
        space_id: document.space_id,
        title: document.title.clone(),
        board: document.board_markdown.is_some(),
        drawing: document.drawing.is_some(),
        excerpt: make_excerpt(text),
        preview,
        word_count: text.split_whitespace().count(),
        created_at: document.created_at,
        updated_at: document.modified_at(),
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
/// miniature: dropping a `<div>` or an `<a>` leaves its children in place. A
/// table row becomes one paragraph, so its cells share a miniature line; the
/// table's own tags drop and leave the cells' words behind.
fn preview_tag(name: &str) -> Option<&'static str> {
    Some(match name {
        "p" | "div" | "tr" => "p",
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

async fn markdown_version(path: &Path, bytes: &[u8]) -> MarkdownFile {
    let stamp = fs::metadata(path).await.ok().as_ref().map(FileStamp::read);
    MarkdownFile::new(bytes, stamp)
}

async fn replace_markdown(
    destination: &Path,
    bytes: &[u8],
    expected: MarkdownFile,
) -> Result<(Vec<u8>, FileStamp), StoreError> {
    let temporary = stage_data_file(destination, bytes).await?;
    let result = async {
        let stamp = FileStamp::read(&fs::metadata(&temporary).await?);
        let previous = markdown_files::checked_bytes(destination, expected).await?;
        replace_file(&temporary, destination).await?;
        Ok((previous, stamp))
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&temporary).await;
    }
    result
}

async fn stage_data_file(destination: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    let mut name = std::ffi::OsString::from(".");
    name.push(destination.file_name().expect("data files have a name"));
    name.push(".tmp");
    let temporary = destination.with_file_name(name);
    let write = async {
        let mut file = fs::File::create(&temporary).await?;
        file.write_all(bytes).await?;
        file.sync_all().await?;
        Ok(temporary.clone())
    };
    let result = write.await;
    if result.is_err() {
        let _ = fs::remove_file(&temporary).await;
    }
    result
}

pub(crate) async fn write_data_file(destination: &Path, bytes: &[u8]) -> io::Result<()> {
    let temporary = stage_data_file(destination, bytes).await?;
    let result = replace_file(&temporary, destination).await;
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
    fn tables_survive_sanitising_without_attributes() {
        let clean = sanitize_content(concat!(
            "<p>Above</p>",
            "<table class=\"layout\" border=\"1\"><thead>",
            "<tr><th scope=\"col\">Name</th><th>Qty</th></tr></thead>",
            "<tbody><tr><td>A &amp; B</td><td>2</td></tr></tbody></table>"
        ));

        assert_eq!(
            clean,
            concat!(
                "<p>Above</p>",
                "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead>",
                "<tbody><tr><td>A &amp; B</td><td>2</td></tr></tbody></table>"
            ),
            "the table tags are kept, bare: {clean}"
        );
    }

    #[test]
    fn scripts_and_styles_inside_a_cell_are_dropped() {
        let clean = sanitize_content(concat!(
            "<table><thead><tr><th>Safe</th></tr></thead><tbody><tr><td>",
            "<script>alert('nope')</script>",
            "<style>p { color: red }</style>",
            "Cell</td></tr></tbody></table>"
        ));

        assert_eq!(
            clean,
            concat!(
                "<table><thead><tr><th>Safe</th></tr></thead>",
                "<tbody><tr><td>Cell</td></tr></tbody></table>"
            ),
            "the cell text survives without its scripts and styles: {clean}"
        );
    }

    #[test]
    fn table_text_does_not_run_cells_together() {
        let html = concat!(
            "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead>",
            "<tbody><tr><td>Tea</td><td>2</td></tr></tbody></table>"
        );

        assert_eq!(html_to_text(html), "Name Qty Tea 2");
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
    fn board_layout_finds_columns_the_way_the_board_page_does() {
        assert!(board_layout("## To do\n"));
        assert!(board_layout("# Board\r\n\r\n## To do\r\n- Card\r\n"));
        assert!(board_layout("\u{feff}## To do"));
        assert!(board_layout("##\tTabbed column"));

        assert!(!board_layout(""));
        assert!(!board_layout("# Only a title\n\nJust prose.\n"));
        assert!(!board_layout("- a card with no column\n"));
        assert!(!board_layout("##No space after the hashes\n"));
        assert!(!board_layout("### Third level is content\n"));
        assert!(!board_layout("## \n"));
        // The board page skips everything inside a code fence, so a heading in
        // one is prose, not a column.
        assert!(!board_layout("```\n## Not a column\n```\n"));
        assert!(!board_layout("````markdown\n## Not a column\n````\n"));
        // A shorter line does not close a longer fence.
        assert!(!board_layout("````\n```\n## Still code\n````\n"));
        // An unclosed fence does not hide a column above it.
        assert!(board_layout("## To do\n```\nstill code\n"));
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
        let store = Store::load(directory.clone()).await.unwrap();
        let id = store.create().await.unwrap().id;
        drop(store);
        fs::write(
            directory.join("Untitled document.md"),
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
    fn a_preview_shows_one_line_per_table_row() {
        let html = concat!(
            "<p>Before</p>",
            "<table><thead><tr><th>Title</th></tr></thead>",
            "<tbody><tr><td>Cell</td></tr></tbody></table>",
            "<p>After</p>"
        );

        assert_eq!(
            preview_html(html),
            "<p>Before</p><p>Title</p><p>Cell</p><p>After</p>"
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
        assert!(fs::read_dir(&directory)
            .await
            .unwrap()
            .next_entry()
            .await
            .unwrap()
            .is_none());

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
        assert!(directory.join("Untitled document.md").is_file());
        assert!(directory.join("Untitled document (2).md").is_file());
        assert_eq!(read_index(&directory).await.unwrap().documents.len(), 2);

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
        assert!(reloaded.search("field note", None).await.is_empty());
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
        assert!(directory.join("A field note (copy).md").exists());

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
        for filename in ["A field note.md", "Untitled document (2).md"] {
            assert!(old.join(filename).exists());
            assert!(new.join(filename).exists());
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
        assert!(new.join("A field note.md").exists());
        assert!(
            old.join("A field note.md").exists(),
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
        let foreign = Store::load(occupied.clone()).await.unwrap();
        foreign.create().await.unwrap();

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
        store.create().await.expect("document is created");

        fs::write(directory.join("notes.txt"), b"hello")
            .await
            .unwrap();
        fs::write(directory.join("config.json"), b"{}")
            .await
            .unwrap();

        let usage = store.usage().await;
        assert_eq!(usage.documents, 1);
        let size = fs::metadata(directory.join("Untitled document.md"))
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
    async fn loads_version_one_markdown_without_rewriting_until_a_document_changes() {
        use serde_json::json;

        let directory = temp_directory("uuid-markdown");
        fs::create_dir(&directory).await.unwrap();
        let active_id = Uuid::new_v4();
        let missing_id = Uuid::new_v4();
        let deleted_id = Uuid::new_v4();
        let unindexed_id = Uuid::new_v4();
        let legacy_body = directory.join(mirror_filename(active_id, MARKDOWN_SUFFIX));
        let image = format!("{active_id}-{}.png", "0".repeat(64));
        let body = format!("Original notes.\n\n![Sketch]({image})\n");
        fs::write(&legacy_body, &body).await.unwrap();
        fs::write(directory.join(&image), [0]).await.unwrap();
        fs::write(
            directory.join(mirror_filename(deleted_id, MARKDOWN_SUFFIX)),
            "Deleted notes.",
        )
        .await
        .unwrap();
        fs::write(
            directory.join(mirror_filename(unindexed_id, MARKDOWN_SUFFIX)),
            "Unindexed notes.",
        )
        .await
        .unwrap();

        let metadata = json!({
            "version": 1,
            "documents": {
                (active_id.to_string()): {
                    "title": "Original notes",
                    "created_at": 10,
                    "updated_at": 20,
                    "paper_width": 1250,
                    "images": { (image.clone()): [{ "width": "80", "height": "40" }] }
                },
                (missing_id.to_string()): { "title": "Missing", "created_at": 10, "updated_at": 20 },
                (deleted_id.to_string()): {
                    "title": "Deleted notes", "created_at": 10, "updated_at": 20, "deleted_at": 30
                }
            }
        })
        .to_string();
        fs::write(directory.join(INDEX_FILE), &metadata)
            .await
            .unwrap();

        let store = Store::load(directory.clone()).await.unwrap();
        let document = store.get(active_id).await.unwrap();
        assert_eq!(document.title, "Original notes");
        assert_eq!(document.created_at, 10);
        assert_eq!(document.updated_at, 20);
        assert_eq!(document.paper_width, Some(1250));
        assert!(document.content.contains("width=\"80\" height=\"40\""));
        assert!(document
            .content
            .contains("src=\"data:image/png;base64,AA==\""));
        assert_eq!(store.list().await.len(), 2);
        assert_eq!(store.list_deleted().await[0].id, deleted_id);
        assert!(store.get(missing_id).await.is_none());
        assert!(store.get(unindexed_id).await.is_some());
        assert_eq!(
            fs::read_to_string(directory.join(INDEX_FILE))
                .await
                .unwrap(),
            metadata
        );
        assert_eq!(fs::read_to_string(&legacy_body).await.unwrap(), body);

        store
            .update(active_id, Some("Renamed notes".into()), None, None)
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("Renamed notes.md"))
                .await
                .unwrap(),
            body
        );
        assert!(!legacy_body.exists());
        let current: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.join(INDEX_FILE)).await.unwrap()).unwrap();
        assert_eq!(current["version"], INDEX_VERSION);
        let reloaded = Store::load(directory.clone()).await.unwrap();
        assert_eq!(
            reloaded.get(active_id).await.unwrap().content,
            document.content
        );
        assert!(reloaded.get(unindexed_id).await.is_some());
        assert_eq!(reloaded.list_deleted().await.len(), 1);
        fs::remove_dir_all(directory).await.unwrap();
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
        let body_path = directory.join("Document title.md");
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
        assert!(!body_path.exists());
        assert_eq!(
            fs::read_to_string(directory.join("Renamed.md"))
                .await
                .unwrap(),
            body
        );
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
        assert_eq!(reopened.search("important thing", None).await.len(), 1);

        fs::remove_dir_all(directory).await.unwrap();
        fs::remove_dir_all(target).await.unwrap();
    }

    #[tokio::test]
    async fn tables_round_trip_through_the_markdown_file() {
        let directory = temp_directory("table-markdown");
        let store = Store::load(directory.clone()).await.unwrap();
        let table = concat!(
            "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr>",
            "<td><b>Tea</b></td>",
            "<td><a href=\"/doc/6f1c2f7a-58f7-4b1e-9f6d-8f1c2f7a58f7\">2</a></td>",
            "</tr></tbody></table>"
        );
        let document = store
            .save_draft(
                Uuid::new_v4(),
                Some("Stock".into()),
                Some(table.into()),
                None,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read_to_string(directory.join("Stock.md"))
                .await
                .unwrap(),
            concat!(
                "| Name | Qty |\n",
                "| --- | --- |\n",
                "| **Tea** | [2](/doc/6f1c2f7a-58f7-4b1e-9f6d-8f1c2f7a58f7) |\n"
            )
        );

        drop(store);
        let reopened = Store::load(directory.clone()).await.unwrap();
        assert_eq!(
            reopened.get(document.id).await.unwrap().content,
            sanitize_content(table)
        );
        let summary = reopened.list().await.remove(0);
        assert_eq!(summary.excerpt, "Name Qty Tea 2");
        fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn a_legacy_drawing_converts_on_save_and_keeps_its_link() {
        let directory = temp_directory("drawing-migration");
        let id = Uuid::new_v4();
        let legacy = "```grapho-drawing-v1\r\n[[[2,3],[4,5]],[[8,9]]]\r\n```\r\n";
        let old_path = directory.join("Sketch.md");
        let occupied_path = directory.join("Sketch.drawing.json");
        let new_path = directory.join("Sketch (2).drawing.json");
        let mut document = Document::blank(id);
        document.title = "Sketch".to_owned();
        document.drawing = Some(DrawingBody::LegacyMarkdown(legacy.to_owned()));
        let mut index = LibraryIndex::default();
        index.documents.insert(
            id,
            DocumentMetadata::from_document(
                &document,
                "Sketch.md".to_owned(),
                ImageAttributes::new(),
            ),
        );
        fs::create_dir_all(&directory).await.unwrap();
        fs::write(&old_path, legacy).await.unwrap();
        fs::write(&occupied_path, b"unrelated file").await.unwrap();
        fs::write(directory.join(INDEX_FILE), index_bytes(&index).unwrap())
            .await
            .unwrap();

        let store = Store::load(directory.clone()).await.unwrap();
        let original = store.get(id).await.unwrap();
        let scene = serde_json::to_value(original.drawing_data(Some(1)).unwrap().unwrap()).unwrap();
        assert_eq!(fs::read_to_string(&old_path).await.unwrap(), legacy);
        let old_backup = store.backup_snapshot(None).await.unwrap();
        let old_backup_index = parse_backup_index(&old_backup.index_bytes(None).unwrap()).unwrap();

        let save = || {
            store.save_drawing(
                id,
                &original.title,
                serde_json::from_value(scene.clone()).unwrap(),
                None,
            )
        };
        let blocked = directory.join(".metadata.json.tmp");
        fs::create_dir(&blocked).await.unwrap();
        assert!(save().await.is_err());
        assert_eq!(fs::read_to_string(&old_path).await.unwrap(), legacy);
        assert!(!new_path.exists());
        fs::remove_dir(blocked).await.unwrap();
        assert_eq!(save().await.unwrap().as_deref(), Some("Sketch"));
        assert!(!old_path.exists());
        assert_eq!(fs::read(&occupied_path).await.unwrap(), b"unrelated file");

        let reopened = Store::load(directory.clone()).await.unwrap();
        let restored = reopened.get(id).await.unwrap();
        assert_eq!(restored.created_at, original.created_at);
        assert_eq!(
            serde_json::to_value(restored.drawing_data(Some(1)).unwrap().unwrap()).unwrap(),
            scene
        );

        // An unrelated batch keeps the old filename in the backup's index
        // until the drawing's own batch copies the JSON version.
        let unrelated = reopened.create().await.unwrap();
        let snapshot = reopened
            .backup_snapshot(Some(&HashSet::from([unrelated.id])))
            .await
            .unwrap();
        let mirror =
            parse_backup_index(&snapshot.index_bytes(Some(&old_backup_index)).unwrap()).unwrap();
        let old_mirror_name = format!("{id}.md");
        assert_eq!(mirror.documents[&id].filename, old_mirror_name);
        assert!(!snapshot.obsolete(&old_mirror_name));
        let snapshot = reopened
            .backup_snapshot(Some(&HashSet::from([id])))
            .await
            .unwrap();
        let mirror = parse_backup_index(&snapshot.index_bytes(Some(&mirror)).unwrap()).unwrap();
        let new_mirror_name = format!("{id}.drawing.json");
        assert_eq!(mirror.documents[&id].filename, new_mirror_name);
        let body = fs::read(&new_path).await.unwrap();
        assert_eq!(snapshot.files[&new_mirror_name], body);
        assert!(snapshot.obsolete(&old_mirror_name));

        let folder = directory.join("sketches");
        reopened
            .save_space(
                None,
                Space {
                    name: "Sketches".to_owned(),
                    folder: Some(folder.clone()),
                },
                false,
            )
            .await
            .unwrap();
        let space = reopened.spaces().await[0].0;
        fs::write(
            folder.join("Sketch (2).drawing.json"),
            b"another unrelated file",
        )
        .await
        .unwrap();
        reopened.move_document(id, Some(space)).await.unwrap();
        assert!(!new_path.exists());
        assert_eq!(
            fs::read(folder.join("Sketch.drawing.json")).await.unwrap(),
            body
        );
        assert_eq!(
            Store::load(directory.clone())
                .await
                .unwrap()
                .get(id)
                .await
                .unwrap()
                .space_id,
            Some(space)
        );
        fs::remove_dir_all(directory).await.unwrap();
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
        assert!(!directory.join("New.md").exists());
        assert!(store.get(id).await.is_none());
        assert!(store
            .update(
                document.id,
                Some("Renamed".into()),
                Some("<p>Changed</p>".into()),
                None
            )
            .await
            .is_err());
        assert!(!directory.join("Renamed.md").exists());
        assert_eq!(store.get(document.id).await.unwrap().title, DEFAULT_TITLE);
        assert!(store
            .update(document.id, None, Some("<p>Changed</p>".into()), None)
            .await
            .is_err());
        assert!(fs::read(directory.join("Untitled document.md"))
            .await
            .unwrap()
            .is_empty());
        assert_eq!(read_index(&directory).await.unwrap().documents.len(), 1);

        fs::remove_dir(blocked).await.unwrap();
        assert!(create().await.unwrap().is_some());
        fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn a_failed_space_move_keeps_the_committed_document_in_its_original_folder() {
        let directory = temp_directory("space-move");
        let folder = directory.join("work");
        let store = Store::load(directory.clone()).await.unwrap();
        store
            .save_space(
                None,
                Space {
                    name: "Work".to_owned(),
                    folder: Some(folder.clone()),
                },
                false,
            )
            .await
            .unwrap();
        let space = store.spaces().await[0].0;
        let document = store.create().await.unwrap();
        let file = "Untitled document.md";
        let blocked = directory.join(".metadata.json.tmp");
        fs::create_dir(&blocked).await.unwrap();

        assert!(store.move_document(document.id, Some(space)).await.is_err());
        assert!(directory.join(file).is_file());
        assert!(!folder.join(file).exists());
        assert_eq!(store.get(document.id).await.unwrap().space_id, None);

        fs::remove_dir(blocked).await.unwrap();
        let moved = store
            .move_document(document.id, Some(space))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(moved.space_id, Some(space));
        assert!(folder.join(file).is_file());
        assert!(!directory.join(file).exists());
        fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn external_markdown_edits_are_read_and_sanitized_on_open() {
        let directory = temp_directory("manual-markdown");
        let store = Store::load(directory.clone()).await.unwrap();
        let document = store.create().await.unwrap();
        drop(store);
        fs::write(
            directory.join("Untitled document.md"),
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

    #[tokio::test]
    async fn same_titles_can_live_in_separate_space_folders_and_keep_both_bodies_on_move() {
        let directory = temp_directory("filename-collision");
        let folder = directory.join("work");
        let store = Store::load(directory.clone()).await.unwrap();
        store
            .save_space(
                None,
                Space {
                    name: "Work".into(),
                    folder: Some(folder.clone()),
                },
                false,
            )
            .await
            .unwrap();
        let space = store.spaces().await[0].0;
        let general = Uuid::new_v4();
        let work = Uuid::new_v4();

        fs::write(directory.join("PROJECT - NOTES.md"), b"Unrelated")
            .await
            .unwrap();
        store
            .save_draft(
                general,
                Some("Project / Notes".into()),
                Some("<p>General</p>".into()),
                None,
            )
            .await
            .unwrap();
        store
            .save_draft_in_space(
                work,
                Some("Project / Notes".into()),
                Some("<p>Work</p>".into()),
                None,
                Some(space),
            )
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(folder.join("Project - Notes.md"))
                .await
                .unwrap(),
            "Work\n"
        );

        // Even a deleted document still owns its filename.
        assert!(store.delete(general).await.unwrap());
        store.move_document(work, None).await.unwrap();
        assert!(!folder.join("Project - Notes.md").exists());
        assert_eq!(
            fs::read_to_string(directory.join("PROJECT - NOTES.md"))
                .await
                .unwrap(),
            "Unrelated"
        );
        assert_eq!(
            fs::read_to_string(directory.join("Project - Notes (2).md"))
                .await
                .unwrap(),
            "General\n"
        );
        assert_eq!(
            fs::read_to_string(directory.join("Project - Notes (3).md"))
                .await
                .unwrap(),
            "Work\n"
        );

        let reloaded = Store::load(directory.clone()).await.unwrap();
        assert_eq!(reloaded.get(work).await.unwrap().title, "Project / Notes");
        assert_eq!(
            reloaded.restore(general).await.unwrap().unwrap().content,
            "<p>General</p>"
        );
        fs::remove_dir_all(directory).await.unwrap();
    }
}
