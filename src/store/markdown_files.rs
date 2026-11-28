//! On-demand reads of indexed Markdown in dedicated Space folders.
use super::{decode_document, Document, DocumentMetadata, StoreError};
use sha2::{Digest, Sha256};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::time::timeout;
use uuid::Uuid;

pub(super) const READ_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct FileStamp {
    modified: Option<SystemTime>,
    len: u64,
}

impl FileStamp {
    pub(super) fn read(metadata: &std::fs::Metadata) -> Self {
        Self {
            modified: metadata.modified().ok(),
            len: metadata.len(),
        }
    }

    pub(super) fn millis(self) -> Option<u64> {
        Some(self.modified?.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct MarkdownFile {
    pub stamp: Option<FileStamp>,
    digest: [u8; 32],
}

impl MarkdownFile {
    pub(super) fn new(bytes: &[u8], stamp: Option<FileStamp>) -> Self {
        Self {
            stamp,
            digest: Sha256::digest(bytes).into(),
        }
    }

    pub(super) fn revision(self) -> String {
        format!("{:x}", sha2::digest::Output::<Sha256>::from(self.digest))
    }

    pub(super) fn matches(self, bytes: &[u8]) -> bool {
        self.digest == Self::new(bytes, None).digest
    }
}

async fn read(path: &Path) -> io::Result<(Vec<u8>, MarkdownFile)> {
    let mut file = fs::File::open(path).await?;
    let stamp = FileStamp::read(&file.metadata().await?);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).await?;
    if stamp != FileStamp::read(&file.metadata().await?) || stamp.len != bytes.len() as u64 {
        return Err(io::Error::other("Markdown changed while it was being read"));
    }
    let version = MarkdownFile::new(&bytes, Some(stamp));
    Ok((bytes, version))
}

pub(super) async fn load(
    folder: &Path,
    id: Uuid,
    metadata: &mut DocumentMetadata,
    cached: Option<&Document>,
) -> Result<Option<Document>, StoreError> {
    timeout(READ_TIMEOUT, async {
        let path = folder.join(&metadata.filename);
        let (bytes, file) = match read(&path).await {
            Ok(result) => result,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        if let Some(cached) = cached.filter(|doc| {
            doc.markdown_file
                .is_some_and(|previous| previous.digest == file.digest)
        }) {
            let mut document = cached.clone();
            document.markdown_file = Some(file);
            return Ok(Some(document));
        }
        let source = String::from_utf8(bytes).map_err(|error| StoreError::Corrupt {
            path,
            message: format!("could not read the document as UTF-8 Markdown: {error}"),
        })?;
        let mut document = decode_document(folder, id, metadata, source).await?;
        document.markdown_file = Some(file);
        Ok(Some(document))
    })
    .await
    .map_err(io::Error::from)?
}

pub(super) async fn checked_bytes(
    path: &Path,
    expected: MarkdownFile,
) -> Result<Vec<u8>, StoreError> {
    let bytes = match timeout(READ_TIMEOUT, fs::read(path))
        .await
        .map_err(io::Error::from)?
    {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(StoreError::FileChanged)
        }
        Err(error) => return Err(error.into()),
    };
    if !expected.matches(&bytes) {
        return Err(StoreError::FileChanged);
    }
    Ok(bytes)
}

pub(super) struct ScannedFile {
    pub stamp: FileStamp,
    pub document: Option<Document>,
}

pub(super) async fn scan(
    folder: PathBuf,
    entries: Vec<(Uuid, DocumentMetadata, Option<FileStamp>)>,
    read_changed: bool,
) -> Vec<(Uuid, Option<ScannedFile>)> {
    let mut files = Vec::with_capacity(entries.len());
    let _ = timeout(READ_TIMEOUT, async {
        for (id, metadata, cached_stamp) in &entries {
            let file = async {
                let stamp =
                    FileStamp::read(&fs::metadata(folder.join(&metadata.filename)).await.ok()?);
                let document = if read_changed && Some(stamp) != *cached_stamp {
                    Some(
                        load(&folder, *id, &mut metadata.clone(), None)
                            .await
                            .ok()??,
                    )
                } else {
                    None
                };
                let stamp = document
                    .as_ref()
                    .and_then(|doc| doc.markdown_file?.stamp)
                    .unwrap_or(stamp);
                Some(ScannedFile { stamp, document })
            }
            .await;
            files.push((*id, file));
        }
    })
    .await;
    if read_changed {
        // Search results must come from a body whose status we could verify.
        files.extend(entries[files.len()..].iter().map(|(id, ..)| (*id, None)));
    }
    files
}
