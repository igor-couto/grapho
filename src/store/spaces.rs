use super::{
    copy_document_files, directory_key, document_files_for, filename_key, folder_for, index_bytes,
    load_document, markdown_files, normalize_title, remove_copies, valid_filename, write_data_file,
    Document, DocumentMetadata, FilenameSet, LibraryIndex, RelocateError, State, Store, StoreError,
    INDEX_FILE, MARKDOWN_SUFFIX,
};
use crate::markdown;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::time::timeout;
use uuid::Uuid;

const GENERAL: &str = "General";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Space {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<PathBuf>,
}

#[derive(Serialize)]
pub struct SpaceSummary {
    id: Uuid,
    name: String,
    available: bool,
}

#[derive(Debug)]
pub enum SpaceError {
    Name,
    NameTaken,
    Missing,
    Import(String),
    Folder(RelocateError),
    Store(StoreError),
}

impl From<io::Error> for SpaceError {
    fn from(error: io::Error) -> Self {
        Self::Store(error.into())
    }
}

impl Store {
    pub async fn spaces(&self) -> Vec<(Uuid, Space, bool)> {
        let state = self.state.read().await;
        let mut spaces: Vec<_> = state
            .index
            .spaces
            .iter()
            .map(|(&id, space)| (id, space.clone(), state.space_is_available(Some(id))))
            .collect();
        spaces.sort_by_cached_key(|(_, space, _)| space.name.to_lowercase());
        spaces
    }

    pub async fn space_summaries(&self) -> Vec<SpaceSummary> {
        self.spaces()
            .await
            .into_iter()
            .map(|(id, space, available)| SpaceSummary {
                id,
                name: space.name,
                available,
            })
            .collect()
    }

    pub async fn save_space(
        &self,
        id: Option<Uuid>,
        mut space: Space,
        import_markdown: bool,
    ) -> Result<Vec<Uuid>, SpaceError> {
        space.name = space.name.trim().to_owned();
        if space.name.is_empty()
            || space.name.chars().count() > 80
            || space.name.chars().any(char::is_control)
        {
            return Err(SpaceError::Name);
        }
        if import_markdown && (id.is_some() || space.folder.is_none()) {
            return Err(SpaceError::Import(
                "Choose an existing folder when creating a Space to import its Markdown files."
                    .to_owned(),
            ));
        }

        let mut state = self.state.write().await;
        state.require_space(id).map_err(|_| SpaceError::Missing)?;
        state
            .require_available_space(id)
            .map_err(SpaceError::Store)?;
        let name = space.name.to_lowercase();
        if name == GENERAL.to_lowercase()
            || state
                .index
                .spaces
                .iter()
                .any(|(&other, entry)| Some(other) != id && entry.name.to_lowercase() == name)
        {
            return Err(SpaceError::NameTaken);
        }

        let source = state.folder_for(id);
        let target = space.folder.as_deref().unwrap_or(&state.directory);
        let target_key = folder_key(target).await?;
        if let Some(folder) = &space.folder {
            if !folder.is_absolute() {
                return Err(SpaceError::Folder(RelocateError::NotAbsolute));
            }
            if target_key == folder_key(&state.directory).await? {
                return Err(SpaceError::Folder(RelocateError::SpaceDirectory));
            }
            state
                .check_space_folders(target, &target_key, id)
                .await
                .map_err(SpaceError::Folder)?;
        }

        let moving = folder_key(source).await? != target_key;
        let mut created = Vec::new();
        let mut index = state.index.clone();
        if moving {
            if space.folder.is_some() {
                if fs::try_exists(target.join(INDEX_FILE)).await? {
                    return Err(SpaceError::Folder(RelocateError::SpaceDirectory));
                }
                if !import_markdown {
                    fs::create_dir_all(target)
                        .await
                        .map_err(|error| SpaceError::Folder(RelocateError::io(target, error)))?;
                }
            }

            if let Some(id) = id {
                let copy = async {
                    let mut filenames = FilenameSet::read(target).await?;
                    for metadata in index
                        .documents
                        .values_mut()
                        .filter(|doc| doc.space_id == Some(id))
                    {
                        let filename = filenames
                            .claim(
                                &metadata.title,
                                metadata.body_suffix(),
                                Some(&metadata.filename),
                                None,
                            )
                            .await?;
                        copy_document_files(
                            metadata,
                            &filename,
                            source,
                            target,
                            false,
                            &mut created,
                        )
                        .await?;
                        metadata.filename = filename;
                    }
                    Ok::<_, io::Error>(())
                };
                if let Err(error) = copy.await {
                    remove_copies(&created).await;
                    return Err(SpaceError::Folder(RelocateError::io(target, error)));
                }
            }
        }

        let id = id.unwrap_or_else(Uuid::new_v4);
        let imported = if import_markdown {
            read_import(target, id, &mut index).await?
        } else {
            Vec::new()
        };
        let previous = if moving && source == state.directory {
            state
                .index
                .documents
                .values()
                .filter(|doc| doc.space_id == Some(id))
                .cloned()
                .collect()
        } else {
            Vec::new()
        };
        index.spaces.insert(id, space);
        state.commit_index(index, &created).await?;
        if moving {
            for document in state
                .documents
                .values_mut()
                .filter(|doc| doc.space_id == Some(id))
            {
                document.markdown_file = None;
            }
        }
        let imported_ids = imported.iter().map(|document| document.id).collect();
        state
            .documents
            .extend(imported.into_iter().map(|document| (document.id, document)));
        // A dedicated previous folder stays as a copy. The shared folder
        // drops the relocated documents while retaining its other Spaces.
        for metadata in previous {
            clean_document_files(&metadata, &state.directory).await;
        }
        Ok(imported_ids)
    }

    pub async fn move_document(
        &self,
        id: Uuid,
        space_id: Option<Uuid>,
    ) -> Result<Option<Document>, StoreError> {
        let mut state = self.state.write().await;
        state.require_space(space_id)?;
        state.require_available_space(space_id)?;
        state.require_document_space(id)?;
        state.refresh_markdown(id).await?;
        let Some(mut document) = state.active_document(id).cloned() else {
            return Ok(None);
        };
        if document.space_id == space_id {
            return Ok(Some(document));
        }

        let source = state.folder_for(document.space_id).to_owned();
        let target = state.folder_for(space_id);
        let moving = source != target;
        let mut created = Vec::new();
        let metadata = state.index.documents[&id].clone();
        let mut index = state.index.clone();
        let updated = index.documents.get_mut(&id).expect("document metadata");
        updated.space_id = space_id;
        if moving {
            if directory_key(&source).await? == directory_key(target).await? {
                return Err(io::Error::other("Space folders resolve to the same location").into());
            }
            let mut filenames = FilenameSet::read(target).await?;
            let filename = filenames
                .claim(
                    &metadata.title,
                    metadata.body_suffix(),
                    Some(&metadata.filename),
                    None,
                )
                .await?;
            if let Err(error) =
                copy_document_files(&metadata, &filename, &source, target, false, &mut created)
                    .await
            {
                remove_copies(&created).await;
                return Err(error.into());
            }
            updated.filename = filename;
        }

        state.commit_index(index, &created).await?;
        document.space_id = space_id;
        if moving {
            document.markdown_file = None;
        }
        if let Some((folder, metadata)) = state.tracked_markdown(id) {
            if let Ok(Some(current)) =
                markdown_files::load(folder, id, &mut metadata.clone(), None).await
            {
                document = current;
            }
        }
        let previous_file = state.documents[&id].markdown_file;
        state.documents.insert(id, document.clone());
        if moving {
            let mut unchanged = true;
            if let Some(expected) = previous_file {
                unchanged =
                    markdown_files::checked_bytes(&source.join(&metadata.filename), expected)
                        .await
                        .is_ok();
            }
            if unchanged {
                clean_document_files(&metadata, &source).await;
            }
        }
        Ok(Some(document))
    }
}

impl State {
    pub(super) fn require_space(&self, id: Option<Uuid>) -> Result<(), StoreError> {
        if id.is_none_or(|id| self.index.spaces.contains_key(&id)) {
            Ok(())
        } else {
            Err(StoreError::UnknownSpace)
        }
    }

    pub(super) fn folder_for(&self, space_id: Option<Uuid>) -> &Path {
        folder_for(&self.directory, &self.index.spaces, space_id)
    }

    pub(super) fn space_is_available(&self, id: Option<Uuid>) -> bool {
        id.is_none_or(|id| !self.unavailable_spaces.contains(&id))
    }

    pub(super) fn require_available_space(&self, id: Option<Uuid>) -> Result<(), StoreError> {
        if self.space_is_available(id) {
            Ok(())
        } else {
            Err(StoreError::UnavailableSpace)
        }
    }

    pub(super) fn require_document_space(&self, id: Uuid) -> Result<(), StoreError> {
        self.require_available_space(self.index.documents.get(&id).and_then(|doc| doc.space_id))
    }

    pub(super) async fn check_space_folders(
        &self,
        target: &Path,
        target_key: &Path,
        except: Option<Uuid>,
    ) -> Result<(), RelocateError> {
        for (&id, space) in &self.index.spaces {
            if let Some(path) = space.folder.as_deref().filter(|_| Some(id) != except) {
                if path == target
                    || path == target_key
                    || (self.space_is_available(Some(id))
                        && directory_key(path)
                            .await
                            .map_err(|error| RelocateError::io(path, error))?
                            == target_key)
                {
                    return Err(RelocateError::SpaceDirectory);
                }
            }
        }
        Ok(())
    }

    async fn commit_index(&mut self, index: LibraryIndex, created: &[PathBuf]) -> io::Result<()> {
        let path = self.directory.join(INDEX_FILE);
        let write = async { write_data_file(&path, &index_bytes(&index)?).await };
        if let Err(error) = write.await {
            remove_copies(created).await;
            return Err(error);
        }
        self.index = index;
        Ok(())
    }
}

pub(super) async fn load_folder(
    folder: &Path,
    entries: Vec<(Uuid, DocumentMetadata)>,
) -> Result<(PathBuf, Vec<(Document, DocumentMetadata)>), StoreError> {
    let key = timeout(markdown_files::READ_TIMEOUT, async {
        drop(fs::read_dir(folder).await?);
        directory_key(folder).await
    })
    .await
    .map_err(io::Error::from)??;
    let mut documents = Vec::with_capacity(entries.len());
    let mut found_body = false;
    for (id, mut metadata) in entries {
        let document = if metadata.drawing {
            let document = timeout(
                markdown_files::READ_TIMEOUT,
                load_document(folder, id, &mut metadata),
            )
            .await
            .map_err(io::Error::from)??;
            found_body = true;
            document
        } else if let Some(document) = markdown_files::load(folder, id, &mut metadata, None).await?
        {
            found_body = true;
            document
        } else {
            // Keep the index entry so one missing file won't hide its neighbors.
            let mut document = metadata.document(id, String::new());
            document.board_markdown = metadata.board.then(String::new);
            document
        };
        documents.push((document, metadata));
    }
    if !documents.is_empty() && !found_body {
        // An unmounted network share can leave an empty mount point behind.
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "no indexed documents in the Space folder",
        )
        .into());
    }
    Ok((key, documents))
}

async fn folder_key(path: &Path) -> Result<PathBuf, SpaceError> {
    directory_key(path)
        .await
        .map_err(|error| SpaceError::Folder(RelocateError::io(path, error)))
}

/// Adopt the existing bodies by adding their metadata in the Space's index commit.
async fn read_import(
    folder: &Path,
    space: Uuid,
    index: &mut LibraryIndex,
) -> Result<Vec<Document>, SpaceError> {
    let mut entries = fs::read_dir(folder).await.map_err(|error| {
        SpaceError::Import(format!(
            "Couldn't read the Space folder for import. {error}"
        ))
    })?;
    let mut filenames = HashSet::new();
    let mut imported = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if !path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            || !entry.file_type().await?.is_file()
        {
            continue;
        }
        let name = entry.file_name();
        let filename = name
            .to_str()
            .filter(|name| valid_filename(name, MARKDOWN_SUFFIX))
            .ok_or_else(|| {
                SpaceError::Import(format!(
                    "Rename “{}” to a portable Markdown filename and try again.",
                    name.to_string_lossy()
                ))
            })?;
        if !filenames.insert(filename_key(filename)) {
            return Err(SpaceError::Import(format!(
                "“{filename}” has the same name as another Markdown file apart from capitalization."
            )));
        }
        let (stem, _) = filename
            .rsplit_once('.')
            .expect("validated Markdown filename");
        let mut document = Document::blank(Uuid::new_v4());
        document.space_id = Some(space);
        document.title = normalize_title(stem);
        let placement = markdown::ImageAttributes::new();
        let mut metadata =
            DocumentMetadata::from_document(&document, filename.to_owned(), placement);
        let document = markdown_files::load(folder, document.id, &mut metadata, None)
            .await
            .map_err(|error| SpaceError::Import(format!("Couldn't import “{filename}”. {error}")))?
            .ok_or_else(|| {
                SpaceError::Import(format!("“{filename}” disappeared during import."))
            })?;
        index.documents.insert(document.id, metadata);
        imported.push(document);
    }
    Ok(imported)
}

async fn clean_document_files(metadata: &DocumentMetadata, folder: &Path) {
    for name in document_files_for(metadata) {
        super::remove_old_body(folder, name).await;
    }
}
