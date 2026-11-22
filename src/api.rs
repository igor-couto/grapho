use std::collections::BTreeSet;
use std::fmt;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use html_escape::encode_text;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::assets;
use crate::auth::{self, Auth};
use crate::backup::{BackupError, BackupMirror};
use crate::disk;
use crate::drive::{self, Drive, OAuthStore, Pending};
use crate::secrets::{Secret, Secrets};
use crate::settings::{self, BackupLocation, BackupTarget, Source};
use crate::store::{
    drawing_strokes, summary_for, DeletedDocument, Document, DocumentKind, DocumentMatch,
    DocumentSummary, PencilStrokes, RelocateError, SharedStore, Space, SpaceError, SpaceSummary,
    StoreError,
};

const BODY_LIMIT_BYTES: usize = 24 * 1024 * 1024;
/// A login is one short JSON object, not a document.
const LOGIN_BODY_LIMIT_BYTES: usize = 4 * 1024;
const CSP: &str = concat!(
    "default-src 'self'; ",
    "script-src 'self'; ",
    "style-src 'self'; ",
    "img-src 'self' data:; ",
    "font-src 'self'; ",
    "connect-src 'self'; ",
    "object-src 'none'; ",
    "base-uri 'none'; ",
    "form-action 'self'; ",
    "frame-ancestors 'none'"
);

/// The version page asks GitHub for the latest release, so its policy allows
/// exactly that one origin. Every other response keeps `connect-src 'self'`.
fn content_security_policy(allows_updates: bool) -> HeaderValue {
    if !allows_updates {
        return HeaderValue::from_static(CSP);
    }

    static WITH_UPDATES: OnceLock<HeaderValue> = OnceLock::new();

    WITH_UPDATES
        .get_or_init(|| {
            HeaderValue::from_str(&CSP.replace(
                "connect-src 'self';",
                "connect-src 'self' https://api.github.com;",
            ))
            .expect("the update policy is a valid header value")
        })
        .clone()
}

#[derive(Clone)]
pub struct AppState {
    pub store: SharedStore,
    pub auth: Option<Arc<Auth>>,
    /// Which rule chose the data folder, so the storage page can explain it.
    pub data_dir_source: Source,
    /// Where a folder chosen on the storage page is remembered. Absent when the
    /// platform gives no per-user configuration directory.
    pub settings_file: Option<PathBuf>,
    pub backups: Arc<BackupMirror>,
    pub drive: Arc<Drive>,
    pub secrets: Arc<Secrets>,
    /// Sign-ins waiting for Google to redirect back.
    oauth: Arc<OAuthStore>,
    /// Settings are one small file edited by two or three rare actions, so a
    /// single lock keeps their read-modify-write cycles from losing each other.
    settings_lock: Arc<tokio::sync::Mutex<()>>,
}

pub struct ServerOptions {
    pub data_dir_source: Source,
    pub settings_file: Option<PathBuf>,
    pub backups: Arc<BackupMirror>,
    pub drive: Arc<Drive>,
    pub secrets: Arc<Secrets>,
}

pub fn router(store: SharedStore, auth: Option<Arc<Auth>>, options: ServerOptions) -> Router {
    let state = AppState {
        store,
        auth,
        data_dir_source: options.data_dir_source,
        settings_file: options.settings_file,
        backups: options.backups,
        drive: options.drive,
        secrets: options.secrets,
        oauth: Arc::new(OAuthStore::new()),
        settings_lock: Arc::new(tokio::sync::Mutex::new(())),
    };

    // Everything that can read or change a document belongs on this router. A
    // route added anywhere else is public, which is why the public list below is
    // deliberately short.
    let protected = Router::new()
        .route("/", get(home_page))
        .route("/board/new", get(new_board_page))
        .route("/board/new/{id}", get(board_draft_page))
        .route("/draw/new", get(new_drawing_page))
        .route("/draw/new/{id}", get(drawing_draft_page))
        .route("/doc/new", get(new_document_page))
        .route("/doc/new/{id}", get(draft_page))
        .route("/doc/{id}", get(editor_page))
        // The storage page reveals a filesystem path and can move the library,
        // so it is as private as the documents themselves.
        .route("/storage", get(storage_page))
        .route("/shortcuts", get(shortcuts_page))
        .route("/api/storage", get(get_storage).put(update_storage))
        .route("/api/storage/spaces", post(add_space))
        .route("/api/storage/spaces/{id}", put(update_space))
        .route("/api/storage/backups", post(add_backup))
        .route("/api/storage/backups/ssh", post(add_ssh_backup))
        .route("/api/storage/backups/google", post(start_google_backup))
        .route("/api/storage/backups/{id}", delete(remove_backup))
        .route(
            "/api/spelling/words",
            get(get_spelling_words)
                .post(add_spelling_word)
                .layer(DefaultBodyLimit::max(1024)),
        )
        .route("/api/documents", get(list_documents).post(create_document))
        .route("/api/documents/search", get(search_documents))
        .route("/api/documents/deleted", get(list_deleted_documents))
        .route(
            "/api/documents/{id}",
            get(get_document)
                .put(update_document)
                .delete(delete_document),
        )
        .route("/api/documents/{id}/draft", put(save_draft))
        .route("/api/documents/{id}/board", get(get_board).put(save_board))
        .route(
            "/api/documents/{id}/drawing",
            get(get_drawing).put(save_drawing),
        )
        .route("/api/documents/{id}/title", get(get_document_title))
        // A copy is a new document, so it is created with POST under its source.
        .route("/api/documents/{id}/duplicate", post(duplicate_document))
        .route("/api/documents/{id}/restore", post(restore_document))
        .route("/api/documents/{id}/space", put(move_document))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

    let public = Router::new()
        .route("/login", get(login_page))
        .route(
            "/api/session",
            post(open_session)
                .delete(close_session)
                .layer(DefaultBodyLimit::max(LOGIN_BODY_LIMIT_BYTES)),
        )
        .route("/api/health", get(health))
        // Build metadata only, and reads no documents, so it can stay public:
        // it answers "which build is this?" without a login.
        .route("/version", get(version_page))
        // Google redirects the browser here from accounts.google.com, and a
        // SameSite=Strict session cookie is not sent on that cross-site
        // navigation. The single-use `state` value is what protects this route.
        .route("/oauth/google/callback", get(google_callback))
        .route("/assets/{*path}", get(asset))
        .fallback(not_found);

    protected
        .merge(public)
        .layer(DefaultBodyLimit::max(BODY_LIMIT_BYTES))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

async fn home_page() -> Response {
    with_page_cache(
        (
            [(header::CACHE_CONTROL, "no-cache")],
            Html(assets::INDEX_HTML),
        )
            .into_response(),
    )
}

#[derive(Deserialize)]
struct SpaceSelection {
    space: Option<Uuid>,
}

#[derive(Deserialize)]
struct LibrarySelection {
    space: Option<String>,
}

impl LibrarySelection {
    fn scope(&self) -> Result<Option<Option<Uuid>>, ApiError> {
        match self.space.as_deref() {
            None => Ok(None),
            Some("general") => Ok(Some(None)),
            Some(id) => Uuid::parse_str(id)
                .map(|id| Some(Some(id)))
                .map_err(|_| ApiError::not_found()),
        }
    }

    fn document_location(&self, path: String) -> Response {
        match self.scope() {
            Ok(None) => redirect_to(&path),
            Ok(Some(None)) => redirect_to(&format!("{path}?space=general")),
            Ok(Some(Some(space))) => redirect_to(&format!("{path}?space={space}")),
            Err(_) => page_not_found(),
        }
    }
}

async fn new_document_page(Query(selection): Query<LibrarySelection>) -> Response {
    selection.document_location(format!("/doc/new/{}", Uuid::new_v4()))
}

async fn new_board_page(Query(selection): Query<LibrarySelection>) -> Response {
    selection.document_location(format!("/board/new/{}", Uuid::new_v4()))
}

async fn board_draft_page(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Query(selection): Query<LibrarySelection>,
) -> Response {
    let Some(id) = parse_document_id(&raw_id) else {
        return page_not_found();
    };
    if state.store.contains_active(id).await {
        return selection.document_location(format!("/doc/{id}"));
    }
    board_html()
}

async fn new_drawing_page(Query(selection): Query<LibrarySelection>) -> Response {
    selection.document_location(format!("/draw/new/{}", Uuid::new_v4()))
}

async fn drawing_draft_page(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Query(selection): Query<LibrarySelection>,
) -> Response {
    let Some(id) = parse_document_id(&raw_id) else {
        return page_not_found();
    };
    if state.store.contains_active(id).await {
        return selection.document_location(format!("/doc/{id}"));
    }
    drawing_html()
}

async fn draft_page(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Query(selection): Query<LibrarySelection>,
) -> Response {
    let Some(id) = parse_document_id(&raw_id) else {
        return page_not_found();
    };
    if state.store.contains_active(id).await {
        // A reload can follow an unload save before the browser has updated
        // the address bar. Reopen the document if its first save made it.
        return selection.document_location(format!("/doc/{id}"));
    }
    editor_html()
}

async fn editor_page(State(state): State<AppState>, Path(raw_id): Path<String>) -> Response {
    let Some(id) = parse_document_id(&raw_id) else {
        return page_not_found();
    };
    match state.store.active_document_kind(id).await {
        Some(DocumentKind::Board) => board_html(),
        Some(DocumentKind::Drawing) => drawing_html(),
        Some(DocumentKind::Text) => editor_html(),
        None => page_not_found(),
    }
}

fn board_html() -> Response {
    with_page_cache(Html(assets::BOARD_HTML).into_response())
}

fn drawing_html() -> Response {
    with_page_cache(Html(assets::DRAWING_HTML).into_response())
}

fn editor_html() -> Response {
    with_page_cache(Html(assets::EDITOR_HTML).into_response())
}

async fn storage_page() -> Response {
    with_page_cache(Html(assets::STORAGE_HTML).into_response())
}

async fn shortcuts_page() -> Response {
    with_page_cache(Html(assets::SHORTCUTS_HTML).into_response())
}

async fn login_page(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let Some(auth) = state.auth.as_deref() else {
        // Without a password there is nothing to unlock.
        return redirect_to("/");
    };

    if let Some(token) = auth::session_token(&headers) {
        if auth.session_is_valid(&token) {
            return redirect_to("/");
        }
    }

    (
        [(header::CACHE_CONTROL, "no-store")],
        Html(assets::LOGIN_HTML),
    )
        .into_response()
}

async fn asset(Path(path): Path<String>) -> Response {
    let Some(asset) = assets::find(&path) else {
        return page_not_found();
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, asset.content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(asset.bytes))
        .expect("static asset response is valid")
}

/// Ask for a session cookie before anything private is served.
///
/// Pages redirect to the login screen so a bookmark still works after signing in;
/// API calls get a 401 the browser UI can act on.
async fn require_auth(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let Some(auth) = state.auth else {
        return next.run(request).await;
    };

    let token = auth::session_token(request.headers());
    let signed_in = token
        .as_deref()
        .is_some_and(|token| auth.session_is_valid(token));

    if !signed_in {
        return if request.uri().path().starts_with("/api/") {
            ApiError::unauthorized("Your session has ended. Sign in to continue.").into_response()
        } else {
            redirect_to(&login_location(&request))
        };
    }

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    // These pages belong to whoever is signed in, so no cache may keep a copy.
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::VARY, HeaderValue::from_static("Cookie"));
    response
}

fn login_location(request: &Request) -> String {
    match request.uri().path_and_query() {
        Some(target) if target.as_str() != "/" => {
            format!("/login?next={}", encode_query_value(target.as_str()))
        }
        _ => "/login".to_owned(),
    }
}

/// Percent-encode a path and query so it survives as one query value. Only the
/// unreserved characters are left alone, so nothing can split the value in two.
fn encode_query_value(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[derive(Serialize)]
struct DocumentList {
    documents: Vec<DocumentSummary>,
    spaces: Vec<SpaceSummary>,
    /// Whether this server asks for a password, so the UI knows to offer sign out.
    auth_required: bool,
}

async fn list_documents(State(state): State<AppState>) -> Json<DocumentList> {
    Json(DocumentList {
        documents: state.store.list().await,
        spaces: state.store.space_summaries().await,
        auth_required: state.auth.is_some(),
    })
}

#[derive(Serialize)]
struct DeletedDocumentList {
    documents: Vec<DeletedDocument>,
}

async fn list_deleted_documents(State(state): State<AppState>) -> Json<DeletedDocumentList> {
    Json(DeletedDocumentList {
        documents: state.store.list_deleted().await,
    })
}

#[derive(Deserialize)]
struct DocumentSearch {
    q: String,
    #[serde(flatten)]
    library: LibrarySelection,
}

#[derive(Serialize)]
struct DocumentSearchResults {
    matches: Vec<DocumentMatch>,
}

async fn search_documents(
    State(state): State<AppState>,
    Query(query): Query<DocumentSearch>,
) -> Result<Json<DocumentSearchResults>, ApiError> {
    let scope = query.library.scope()?;
    if let Some(Some(id)) = scope {
        state.store.require_available_space(id).await?;
    }
    Ok(Json(DocumentSearchResults {
        matches: state.store.search(&query.q, scope).await,
    }))
}

#[derive(Serialize)]
struct DocumentView {
    id: Uuid,
    space_id: Option<Uuid>,
    title: String,
    content: String,
    paper_width: Option<u32>,
    created_at: u64,
    updated_at: u64,
}

impl From<Document> for DocumentView {
    fn from(document: Document) -> Self {
        Self {
            id: document.id,
            space_id: document.space_id,
            title: document.title,
            content: document.content,
            paper_width: document.paper_width,
            created_at: document.created_at,
            updated_at: document.updated_at,
        }
    }
}

async fn create_document(
    State(state): State<AppState>,
    Query(selection): Query<SpaceSelection>,
) -> Result<impl IntoResponse, ApiError> {
    let document = state.store.create_in_space(selection.space).await?;
    state.backups.mirror_document(document.id);
    Ok((StatusCode::CREATED, Json(DocumentView::from(document))))
}

/// Copy a document into a new one.
///
/// The answer is the library summary of the copy rather than the full document:
/// a copy is made from the home page, and the server already derives the
/// preview and excerpt the listing shows, so the browser needs no second
/// request to put the new card on screen.
async fn duplicate_document(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
) -> Result<impl IntoResponse, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    let document = state
        .store
        .duplicate(id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    state.backups.mirror_document(document.id);
    Ok((StatusCode::CREATED, Json(summary_for(&document))))
}

async fn get_document(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
) -> Result<Json<DocumentView>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    state.store.require_document_space(id).await?;
    let document = state.store.get(id).await.ok_or_else(ApiError::not_found)?;
    Ok(Json(DocumentView::from(document)))
}

#[derive(Serialize)]
struct BoardDocument {
    title: String,
    markdown: String,
}

impl BoardDocument {
    fn from_document(document: Document) -> Result<Json<Self>, ApiError> {
        let markdown = document.board_markdown.ok_or_else(ApiError::not_found)?;
        Ok(Json(Self {
            title: document.title,
            markdown,
        }))
    }
}

async fn get_board(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
) -> Result<Json<BoardDocument>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    state.store.require_document_space(id).await?;
    let document = state.store.get(id).await.ok_or_else(ApiError::not_found)?;
    BoardDocument::from_document(document)
}

#[derive(Deserialize)]
struct ExtensionDraftSelection {
    space: Option<Uuid>,
    #[serde(default)]
    draft: bool,
}

#[derive(Deserialize)]
struct SaveBoardRequest {
    markdown: String,
}

async fn save_board(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Query(selection): Query<ExtensionDraftSelection>,
    Json(request): Json<SaveBoardRequest>,
) -> Result<Json<BoardDocument>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    let document = state
        .store
        .save_board(
            id,
            request.markdown,
            selection.draft.then_some(selection.space),
        )
        .await?
        .ok_or_else(ApiError::not_found)?;
    state.backups.mirror_document(id);
    BoardDocument::from_document(document)
}

#[derive(Deserialize, Serialize)]
struct DrawingDocument {
    title: String,
    strokes: PencilStrokes,
}

async fn get_drawing(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
) -> Result<Json<DrawingDocument>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    state.store.require_document_space(id).await?;
    let document = state.store.get(id).await.ok_or_else(ApiError::not_found)?;
    let source = document.drawing_markdown.ok_or_else(ApiError::not_found)?;
    let strokes = drawing_strokes(&source)
        .ok_or_else(|| ApiError::server_error("Grapho couldn't read this drawing."))?;
    Ok(Json(DrawingDocument {
        title: document.title,
        strokes,
    }))
}

async fn save_drawing(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Query(selection): Query<ExtensionDraftSelection>,
    Json(request): Json<DrawingDocument>,
) -> Result<Json<String>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    let title = state
        .store
        .save_drawing(
            id,
            &request.title,
            &request.strokes,
            selection.draft.then_some(selection.space),
        )
        .await?
        .ok_or_else(ApiError::not_found)?;
    state.backups.mirror_document(id);
    Ok(Json(title))
}

async fn get_document_title(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
) -> Result<Json<String>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    state.store.require_document_space(id).await?;
    state
        .store
        .title(id)
        .await
        .map(Json)
        .ok_or_else(ApiError::not_found)
}

async fn get_spelling_words(
    State(state): State<AppState>,
) -> Result<Json<BTreeSet<String>>, ApiError> {
    state
        .store
        .spelling_words()
        .await
        .map(Json)
        .map_err(spelling_error)
}

#[derive(Deserialize)]
struct AddSpellingWordRequest {
    word: String,
}

async fn add_spelling_word(
    State(state): State<AppState>,
    Json(payload): Json<AddSpellingWordRequest>,
) -> Result<Json<BTreeSet<String>>, ApiError> {
    let word = payload.word.trim().to_lowercase().replace('\u{2019}', "'");
    let valid = word.encode_utf16().count() <= 40
        && word.split('\'').all(|part| {
            let mut chars = part.chars();
            chars.next().is_some_and(char::is_alphabetic)
                && chars.all(|c| c.is_alphabetic() || ('\u{0300}'..='\u{036f}').contains(&c))
        });
    if !valid {
        return Err(ApiError::bad_request(
            "Add one word of up to 40 characters.",
        ));
    }
    state
        .store
        .add_spelling_word(word)
        .await
        .map(Json)
        .map_err(spelling_error)
}

fn spelling_error(error: io::Error) -> ApiError {
    eprintln!("could not access custom spelling words: {error}");
    ApiError::server_error("Grapho couldn't access your custom dictionary.")
}

#[derive(Deserialize, Default)]
struct UpdateDocumentRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    paper_width: Option<u32>,
}

async fn update_document(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Json(patch): Json<UpdateDocumentRequest>,
) -> Result<Json<DocumentView>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    let document = state
        .store
        .update(id, patch.title, patch.content, patch.paper_width)
        .await?
        .ok_or_else(ApiError::not_found)?;
    state.backups.mirror_document(document.id);
    Ok(Json(DocumentView::from(document)))
}

async fn save_draft(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Query(selection): Query<SpaceSelection>,
    Json(patch): Json<UpdateDocumentRequest>,
) -> Result<Json<DocumentView>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    let document = state
        .store
        .save_draft_in_space(
            id,
            patch.title,
            patch.content,
            patch.paper_width,
            selection.space,
        )
        .await?
        .ok_or_else(ApiError::not_found)?;
    state.backups.mirror_document(document.id);
    Ok(Json(DocumentView::from(document)))
}

async fn delete_document(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    if state.store.delete(id).await? {
        state.backups.mirror_document(id);
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found())
    }
}

async fn restore_document(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
) -> Result<Json<DocumentSummary>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    let document = state
        .store
        .restore(id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    state.backups.mirror_document(id);
    Ok(Json(summary_for(&document)))
}

#[derive(Deserialize)]
struct MoveDocumentRequest {
    space_id: Option<Uuid>,
}

async fn move_document(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(payload): Json<MoveDocumentRequest>,
) -> Result<Json<DocumentSummary>, ApiError> {
    let document = state
        .store
        .move_document(id, payload.space_id)
        .await?
        .ok_or_else(ApiError::not_found)?;
    state.backups.mirror_document(id);
    Ok(Json(summary_for(&document)))
}

/// One backup connector as the page shows it.
#[derive(Serialize)]
struct BackupView {
    id: Uuid,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder: Option<String>,
    /// The last failure for this connector, or `None` when the last copy worked.
    error: Option<String>,
}

impl BackupView {
    fn new(backup: &crate::settings::BackupLocation, error: Option<String>) -> Self {
        let mut view = Self {
            id: backup.id,
            kind: "folder",
            path: None,
            host: None,
            port: None,
            user: None,
            dir: None,
            folder: None,
            error,
        };

        match &backup.target {
            BackupTarget::Folder { path } => {
                view.path = Some(path.display().to_string());
            }
            BackupTarget::Ssh {
                host,
                port,
                user,
                dir,
                ..
            } => {
                view.kind = "ssh";
                view.host = Some(host.clone());
                view.port = Some(*port);
                view.user = Some(user.clone());
                view.dir = Some(dir.clone());
            }
            BackupTarget::GoogleDrive { folder, .. } => {
                view.kind = "googledrive";
                view.folder = Some(folder.clone());
            }
        }

        view
    }
}

/// What the storage page shows: where the files are, how much room they take,
/// which folders mirror them, and whether this user can change any of it.
#[derive(Serialize)]
struct StorageView {
    path: String,
    source: Source,
    editable: bool,
    documents: usize,
    bytes: u64,
    /// Absent when the platform or the folder cannot answer.
    disk: Option<disk::DiskSpace>,
    spaces: Vec<SpaceStorageView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    imported_documents: Option<usize>,
    backups: Vec<BackupView>,
    /// False when the platform gives nowhere to remember backup folders.
    backups_editable: bool,
}

#[derive(Serialize)]
struct SpaceStorageView {
    id: Uuid,
    name: String,
    folder: Option<String>,
    available: bool,
}

async fn storage_view(state: &AppState) -> StorageView {
    let path = state.store.directory().await;
    let usage = state.store.usage().await;

    // A folder chosen on this page is remembered and becomes the settings
    // source at once, not only after the next start.
    let saved = state
        .settings_file
        .as_deref()
        .map(settings::read)
        .and_then(|settings| settings.data_dir);
    let source = match state.data_dir_source {
        Source::Environment => Source::Environment,
        _ if saved.as_deref() == Some(path.as_path()) => Source::Settings,
        other => other,
    };

    let health = state.backups.health().await;
    let backups = state
        .backups
        .connectors()
        .await
        .into_iter()
        .map(|backup| BackupView::new(&backup, health.get(&backup.id).cloned().flatten()))
        .collect();

    StorageView {
        path: path.display().to_string(),
        source,
        // A folder chosen in the environment belongs to whoever started Grapho;
        // a build with no per-user configuration directory has nowhere to
        // remember a choice either.
        editable: state.data_dir_source != Source::Environment && state.settings_file.is_some(),
        documents: usage.documents,
        bytes: usage.bytes,
        disk: disk::space_for(&path),
        imported_documents: None,
        spaces: state
            .store
            .spaces()
            .await
            .into_iter()
            .map(|(id, space, available)| SpaceStorageView {
                id,
                name: space.name,
                folder: space.folder.map(|folder| folder.display().to_string()),
                available,
            })
            .collect(),
        backups,
        backups_editable: state.settings_file.is_some(),
    }
}

async fn get_storage(State(state): State<AppState>) -> Json<StorageView> {
    Json(storage_view(&state).await)
}

#[derive(Deserialize)]
struct SaveSpaceRequest {
    name: String,
    folder: Option<String>,
    #[serde(default)]
    import_markdown: bool,
}

async fn add_space(
    State(state): State<AppState>,
    Json(payload): Json<SaveSpaceRequest>,
) -> Result<(StatusCode, Json<StorageView>), ApiError> {
    Ok((
        StatusCode::CREATED,
        save_space(&state, None, payload).await?,
    ))
}

async fn update_space(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Json(payload): Json<SaveSpaceRequest>,
) -> Result<Json<StorageView>, ApiError> {
    save_space(&state, Some(id), payload).await
}

async fn save_space(
    state: &AppState,
    id: Option<Uuid>,
    payload: SaveSpaceRequest,
) -> Result<Json<StorageView>, ApiError> {
    let folder = payload
        .folder
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    if folder.is_some_and(|path| path.contains('\0') || path.chars().count() > 4096) {
        return Err(ApiError::bad_request("That folder path can't be used."));
    }
    let folder = folder.map(PathBuf::from);
    let imported = {
        let _guard = state.settings_lock.lock().await;
        if let Some(id) = id {
            state.store.require_available_space(id).await?;
        }
        if let Some(path) = &folder {
            state
                .backups
                .validate_data_folder(path)
                .await
                .map_err(backup_error)?;
        }
        state.store.save_space(id, Space { name: payload.name, folder }, payload.import_markdown)
            .await
            .map_err(|error| match error {
                SpaceError::Name => ApiError::bad_request("Enter a Space name of up to 80 characters."),
                SpaceError::NameTaken => ApiError::conflict("That Space name is already in use."),
                SpaceError::Missing => ApiError::not_found(),
                SpaceError::Import(message) => ApiError::bad_request(message),
                SpaceError::Folder(RelocateError::Occupied { .. }) => ApiError::conflict(
                    "That folder holds documents from another library or Space. Choose an empty folder.",
                ),
                SpaceError::Folder(error) => relocation_error(error),
                SpaceError::Store(error) => error.into(),
            })?
    };
    let count = imported.len();
    state.backups.mirror_space(imported);
    let mut view = storage_view(state).await;
    view.imported_documents = payload.import_markdown.then_some(count);
    Ok(Json(view))
}

#[derive(Deserialize)]
struct RelocateRequest {
    #[serde(default)]
    path: String,
}

async fn update_storage(
    State(state): State<AppState>,
    Json(payload): Json<RelocateRequest>,
) -> Result<Json<StorageView>, ApiError> {
    let requested = payload.path.trim();
    if requested.is_empty() {
        return Err(ApiError::bad_request(
            "Enter the folder where Grapho should keep your documents.",
        ));
    }
    if requested.contains('\0') || requested.chars().count() > 4096 {
        return Err(ApiError::bad_request("That folder path can't be used."));
    }

    // GRAPHO_DATA_DIR belongs to whoever started the server, so the browser
    // cannot overrule it.
    if state.data_dir_source == Source::Environment {
        return Err(ApiError::bad_request(
            "This folder is set by GRAPHO_DATA_DIR. Change it where Grapho starts.",
        ));
    }

    let Some(settings_file) = state.settings_file.clone() else {
        return Err(ApiError::bad_request(
            "Grapho can't remember a folder choice on this system.",
        ));
    };

    {
        // A simultaneous backup add must see the new library, or the move must
        // see the new backup, before either one starts copying documents.
        let _guard = state.settings_lock.lock().await;
        let target = PathBuf::from(requested);
        state
            .backups
            .validate_data_folder(&target)
            .await
            .map_err(backup_error)?;
        let relocated = state
            .store
            .relocate(target)
            .await
            .map_err(relocation_error)?;
        let mut saved = settings::read(&settings_file);
        saved.data_dir = Some(relocated.directory.clone());
        if let Err(error) = settings::write(&settings_file, &saved).await {
            eprintln!("could not save the data folder setting: {error}");
            return Err(ApiError::server_error(format!(
                "Grapho is using that folder now, but couldn't remember the choice for the next start: {error}"
            )));
        }
    }

    Ok(Json(storage_view(&state).await))
}

#[derive(Deserialize)]
struct AddBackupRequest {
    #[serde(default)]
    path: String,
}

/// Add a backup folder: validate it, copy the library into it, remember it.
async fn add_backup(
    State(state): State<AppState>,
    Json(payload): Json<AddBackupRequest>,
) -> Result<Json<StorageView>, ApiError> {
    let requested = payload.path.trim();
    if requested.is_empty() {
        return Err(ApiError::bad_request(
            "Enter the folder that should receive the backup.",
        ));
    }
    if requested.contains('\0') || requested.chars().count() > 4096 {
        return Err(ApiError::bad_request("That folder path can't be used."));
    }

    add_and_remember(
        &state,
        BackupTarget::Folder {
            path: PathBuf::from(requested),
        },
    )
    .await
}

#[derive(Deserialize)]
struct AddSshRequest {
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    user: String,
    #[serde(default)]
    dir: String,
    #[serde(default)]
    key: Option<String>,
}

/// Add an SSH backup: check the fields, prove the server works by copying the
/// library, and remember it.
async fn add_ssh_backup(
    State(state): State<AppState>,
    Json(payload): Json<AddSshRequest>,
) -> Result<Json<StorageView>, ApiError> {
    let key = payload
        .key
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from);

    add_and_remember(
        &state,
        BackupTarget::Ssh {
            host: payload.host,
            port: payload.port.unwrap_or(22),
            user: payload.user,
            dir: payload.dir,
            key,
        },
    )
    .await
}

/// Both kinds end the same way: the mirror copies the library, then the choice
/// is written down. If the file cannot be written the connector is dropped
/// again, because a backup that is not remembered is a trap.
async fn add_and_remember(
    state: &AppState,
    target: BackupTarget,
) -> Result<Json<StorageView>, ApiError> {
    let Some(settings_file) = state.settings_file.clone() else {
        return Err(ApiError::bad_request(
            "Grapho can't remember backups on this system.",
        ));
    };

    {
        let _guard = state.settings_lock.lock().await;
        let location = state
            .backups
            .add(BackupLocation {
                id: Uuid::new_v4(),
                target,
            })
            .await
            .map_err(backup_error)?;
        let mut saved = settings::read(&settings_file);
        saved.backups = state.backups.connectors().await;
        if let Err(error) = settings::write(&settings_file, &saved).await {
            eprintln!("could not save the backup setting: {error}");
            let _ = state.backups.remove(location.id).await;
            return Err(ApiError::server_error(format!(
                "Grapho couldn't remember that backup: {error}"
            )));
        }
    }

    Ok(Json(storage_view(state).await))
}

/// Stop mirroring into a folder. The copies already there are left alone.
async fn remove_backup(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
) -> Result<Json<StorageView>, ApiError> {
    let id = Uuid::parse_str(&raw_id).map_err(|_| ApiError::not_found())?;

    let Some(settings_file) = state.settings_file.clone() else {
        return Err(ApiError::bad_request(
            "Grapho can't remember backup folders on this system.",
        ));
    };

    {
        // Under the lock, the connector list read here is the same one the
        // settings file is about to describe.
        let _guard = state.settings_lock.lock().await;

        let connectors = state.backups.connectors().await;
        if !connectors.iter().any(|backup| backup.id == id) {
            return Err(ApiError::not_found());
        }

        let mut saved = settings::read(&settings_file);
        saved.backups = connectors
            .into_iter()
            .filter(|backup| backup.id != id)
            .collect();
        if let Err(error) = settings::write(&settings_file, &saved).await {
            eprintln!("could not save the backup folder setting: {error}");
            return Err(ApiError::server_error(format!(
                "Grapho couldn't remove that backup folder: {error}"
            )));
        }

        state.backups.remove(id).await;
    }

    // A connector that kept a sign-in must not leave it behind.
    let _ = state.secrets.remove(id).await;

    Ok(Json(storage_view(&state).await))
}

fn backup_error(error: BackupError) -> ApiError {
    let message = error.to_string();

    match &error {
        BackupError::NotAbsolute
        | BackupError::SameAsDataFolder
        | BackupError::InsideDataFolder
        | BackupError::ContainsDataFolder
        | BackupError::Invalid { .. } => ApiError::bad_request(message),
        BackupError::AlreadyABackup | BackupError::Occupied { .. } => ApiError::conflict(message),
        BackupError::Ssh { .. } | BackupError::Google { .. } => {
            eprintln!("{message}");
            ApiError::bad_gateway(message)
        }
        BackupError::Io { .. } => {
            eprintln!("{message}");
            ApiError::server_error(message)
        }
    }
}

#[derive(Deserialize)]
struct GoogleStartRequest {
    #[serde(default)]
    client_id: String,
    #[serde(default)]
    client_secret: String,
    #[serde(default)]
    folder: String,
}

/// Begin the Google sign-in: remember the client and the PKCE secret, and hand
/// the browser a URL for Google's consent screen.
async fn start_google_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<GoogleStartRequest>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if state.settings_file.is_none() || !state.secrets.available() {
        return Err(ApiError::bad_request(
            "Grapho can't remember a Google Drive sign-in on this system.",
        ));
    }

    let client_id = payload.client_id.trim();
    let client_secret = payload.client_secret.trim();
    let folder = payload.folder.trim();

    if client_id.is_empty() || client_secret.is_empty() {
        return Err(ApiError::bad_request(
            "Paste the OAuth client id and client secret from your Google Cloud project.",
        ));
    }

    let folder_ok = !folder.is_empty()
        && folder.chars().count() <= 100
        && !folder.chars().any(char::is_control);
    if !folder_ok {
        return Err(ApiError::bad_request(
            "Give the Drive folder a name of up to 100 characters.",
        ));
    }

    // Google only redirects back to a loopback IP literal, and the browser is on
    // this machine anyway. A host name such as `localhost` would be refused.
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let loopback = host.starts_with("127.0.0.1:") || host.starts_with("[::1]:");
    if !loopback {
        return Err(ApiError::bad_request(
            "Open Grapho at http://127.0.0.1:... to connect Google Drive; Google only redirects back to a loopback address.",
        ));
    }
    let redirect_uri = format!("http://{host}/oauth/google/callback");

    let verifier = drive::new_verifier().map_err(ApiError::server_error)?;
    let challenge = drive::challenge(&verifier);
    let pending = Pending::new(
        client_id.to_owned(),
        client_secret.to_owned(),
        folder.to_owned(),
        redirect_uri.clone(),
        verifier,
    );
    let state_value = state.oauth.begin(pending).map_err(ApiError::server_error)?;
    let auth_url =
        state
            .drive
            .authorization_url(client_id, &redirect_uri, &state_value, &challenge);

    Ok(Json(serde_json::json!({ "auth_url": auth_url })))
}

#[derive(Deserialize)]
struct GoogleCallbackQuery {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

async fn google_callback(
    State(state): State<AppState>,
    Query(query): Query<GoogleCallbackQuery>,
) -> Response {
    match finish_google(&state, query).await {
        Ok(()) => oauth_page(
            "Google Drive connected",
            "The backup is ready. Returning to Storage…",
            Some("/storage?drive=connected"),
        ),
        Err(message) => oauth_page("Google Drive wasn't connected", &message, None),
    }
}

/// The second half of the sign-in: exchange the code, find or create the folder,
/// store the refresh token, and seed the library.
async fn finish_google(state: &AppState, query: GoogleCallbackQuery) -> Result<(), String> {
    if let Some(error) = query.error.filter(|value| !value.is_empty()) {
        return Err(format!(
            "Google returned an error instead of a code: {error}."
        ));
    }

    let state_value = query
        .state
        .ok_or("The sign-in response is missing its state.")?;
    let pending = state
        .oauth
        .take(&state_value)
        .ok_or("That sign-in link has expired or was already used. Start again from Storage.")?;
    let code = query
        .code
        .ok_or("Google did not send an authorization code.")?;

    let Some(settings_file) = state.settings_file.clone() else {
        return Err("Grapho can't remember a Google Drive sign-in on this system.".to_owned());
    };

    let drive = state.drive.clone();
    let (exchange_id, exchange_secret) = (pending.client_id.clone(), pending.client_secret.clone());
    let (redirect_uri, verifier) = (pending.redirect_uri.clone(), pending.verifier.clone());
    let tokens = tokio::task::spawn_blocking(move || {
        drive.exchange(
            &exchange_id,
            &exchange_secret,
            &code,
            &redirect_uri,
            &verifier,
        )
    })
    .await
    .map_err(|error| format!("The sign-in task stopped: {error}"))??;

    let refresh_token = tokens.refresh_token.clone().ok_or(
        "Google did not return a refresh token. Remove Grapho's access from your Google account and try again.",
    )?;

    let drive = state.drive.clone();
    let access = tokens.access_token.clone();
    let folder_name = pending.folder.clone();
    let folder = tokio::task::spawn_blocking(move || drive.ensure_folder(&access, &folder_name))
        .await
        .map_err(|error| format!("The Drive task stopped: {error}"))??;

    let id = Uuid::new_v4();
    state
        .secrets
        .set(
            id,
            Secret {
                client_secret: pending.client_secret,
                refresh_token,
            },
        )
        .await
        .map_err(|error| format!("Grapho couldn't save the Google sign-in: {error}"))?;

    // The token just obtained is still valid, so the first seed needs no refresh.
    state.drive.cache(id, &tokens);

    let location = BackupLocation {
        id,
        target: BackupTarget::GoogleDrive {
            client_id: pending.client_id,
            folder: folder.name,
            folder_id: folder.id,
        },
    };

    if let Err(error) = state.backups.add(location).await {
        let _ = state.secrets.remove(id).await;
        return Err(error.to_string());
    }

    {
        let _guard = state.settings_lock.lock().await;
        let mut saved = settings::read(&settings_file);
        saved.backups = state.backups.connectors().await;
        if let Err(error) = settings::write(&settings_file, &saved).await {
            let _ = state.backups.remove(id).await;
            let _ = state.secrets.remove(id).await;
            return Err(format!("Grapho couldn't remember the backup: {error}"));
        }
    }

    Ok(())
}

/// A small page for the end of the OAuth round trip. It uses a `<meta>` refresh
/// rather than a script because the CSP forbids inline scripts.
fn oauth_page(title: &str, message: &str, redirect: Option<&str>) -> Response {
    let refresh = redirect
        .map(|target| {
            format!(
                "<meta http-equiv=\"refresh\" content=\"1; url={}\">",
                encode_text(target)
            )
        })
        .unwrap_or_default();
    let back = if redirect.is_some() {
        String::new()
    } else {
        "<p class=\"version-update\"><a href=\"/storage\">Back to Storage</a></p>".to_owned()
    };

    let page = format!(
        concat!(
            "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">",
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
            "<title>{title} — Grapho</title><meta name=\"theme-color\" content=\"#232126\">",
            "<link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/favicon.ico\">",
            "<script src=\"/assets/theme.js\"></script>{refresh}",
            "<link rel=\"stylesheet\" href=\"/assets/app.css\"></head>",
            "<body class=\"version-page\"><main class=\"version-main shell\">",
            "<div class=\"version-card\"><h1>{title}</h1>",
            "<p class=\"version-update\">{message}</p>{back}</div></main></body></html>"
        ),
        title = encode_text(title),
        message = encode_text(message),
        refresh = refresh,
        back = back,
    );

    with_page_cache(
        (
            [(header::CACHE_CONTROL, "no-store")],
            Html(page).into_response(),
        )
            .into_response(),
    )
}

fn relocation_error(error: RelocateError) -> ApiError {
    match error {
        RelocateError::NotAbsolute => full_folder_path_error(),
        RelocateError::SameDirectory => {
            ApiError::bad_request("That is already the folder Grapho uses.")
        }
        RelocateError::SpaceDirectory => {
            ApiError::conflict("That folder is already used by Grapho. Choose a different folder.")
        }
        RelocateError::Occupied { documents } => {
            let what = if documents == 1 {
                "a document from another Grapho library".to_owned()
            } else {
                format!("{documents} documents from another Grapho library")
            };
            ApiError::conflict(format!(
                "That folder already holds {what}. Choose an empty folder."
            ))
        }
        RelocateError::Io { path, message } => {
            eprintln!("could not use {}: {message}", path.display());
            ApiError::server_error(format!("Grapho couldn't use that folder: {message}"))
        }
    }
}

fn full_folder_path_error() -> ApiError {
    #[cfg(windows)]
    let example = "C:\\Documents\\Grapho";
    #[cfg(not(windows))]
    let example = "/home/you/Documents";

    ApiError::bad_request(format!("Enter a full folder path, such as {example}."))
}

#[derive(Deserialize)]
struct LoginRequest {
    #[serde(default)]
    password: String,
}

/// Exchange the password for a session cookie.
async fn open_session(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Response {
    let Some(auth) = state.auth.clone() else {
        return ApiError::bad_request("Grapho has no password set.").into_response();
    };

    // The address of the connection itself, never a forwarded header: a client
    // cannot pick a new address per guess, so its attempts share one pause.
    let peer = peer.ip();

    // `check_password` checks the pause again under the verification permit,
    // where a burst of attempts cannot race it. This first check only saves an
    // already-paused client from queueing behind those attempts.
    if let Some(retry_after) = auth.retry_after(peer) {
        return too_many_attempts(retry_after);
    }

    match auth.check_password(payload.password, peer).await {
        Ok(auth::Verdict::Accepted) => {}
        Ok(auth::Verdict::Rejected) => {
            return ApiError::unauthorized("That password is not correct.").into_response()
        }
        Ok(auth::Verdict::Paused(retry_after)) => return too_many_attempts(retry_after),
        Err(error) => {
            eprintln!("login error: {error}");
            return ApiError::server_error("Grapho couldn't check that password.").into_response();
        }
    }

    // A browser that logs in again gets a fresh token, and the old one goes away.
    if let Some(previous) = auth::session_token(&headers) {
        auth.end_session(&previous);
    }

    match auth.begin_session() {
        Ok(token) => {
            let secure = auth::request_is_secure(&headers);
            let mut response = StatusCode::NO_CONTENT.into_response();
            set_cookie(&mut response, &auth::session_cookie(&token, secure));
            response
        }
        Err(error) => {
            eprintln!("session error: {error}");
            ApiError::server_error("Grapho couldn't start a session.").into_response()
        }
    }
}

/// End the session in this browser, whether or not it is still valid.
async fn close_session(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(auth) = state.auth.as_deref() {
        if let Some(token) = auth::session_token(&headers) {
            auth.end_session(&token);
        }
    }

    let mut response = StatusCode::NO_CONTENT.into_response();
    set_cookie(
        &mut response,
        &auth::cleared_session_cookie(auth::request_is_secure(&headers)),
    );
    response
}

fn set_cookie(response: &mut Response, cookie: &str) {
    // Tokens are lowercase hex and attributes are ours, so this cannot fail.
    if let Ok(value) = HeaderValue::from_str(cookie) {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
}

fn too_many_attempts(retry_after: Duration) -> Response {
    let seconds = retry_after.as_secs().max(1);
    let message = if seconds >= 120 {
        format!(
            "Too many incorrect passwords. Try again in {} minutes.",
            seconds.div_ceil(60)
        )
    } else {
        format!("Too many incorrect passwords. Try again in {seconds} seconds.")
    };

    let mut response = ApiError::too_many_requests(message).into_response();
    if let Ok(value) = HeaderValue::from_str(&seconds.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn redirect_to(target: &str) -> Response {
    let location = HeaderValue::from_str(target).unwrap_or(HeaderValue::from_static("/"));
    (
        StatusCode::SEE_OTHER,
        [
            (header::LOCATION, location),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
    )
        .into_response()
}

#[derive(Serialize)]
struct Health {
    status: &'static str,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

/// The commit fields come from `build.rs` and are absent when the binary was
/// built without a `.git` directory, which the page reports plainly.
async fn version_page() -> Response {
    let page = assets::VERSION_HTML
        .replace(
            "{{version}}",
            &build_fact(Some(env!("CARGO_PKG_VERSION")), "unknown"),
        )
        .replace(
            "{{tag}}",
            &build_fact(option_env!("GRAPHO_TAG"), "not a tagged build"),
        )
        .replace(
            "{{commit}}",
            &build_fact(option_env!("GRAPHO_COMMIT"), "unknown"),
        )
        .replace(
            "{{commit_date}}",
            &build_fact(option_env!("GRAPHO_COMMIT_DATE"), "unknown"),
        );

    with_page_cache(Html(page).into_response())
}

/// Git values reach the page from the build, so they are escaped like any other
/// untrusted text.
fn build_fact(value: Option<&str>, fallback: &str) -> String {
    encode_text(value.unwrap_or(fallback)).into_owned()
}

fn parse_document_id(raw_id: &str) -> Option<Uuid> {
    Uuid::parse_str(raw_id).ok()
}

async fn not_found(request: Request) -> Response {
    if request.uri().path().starts_with("/api/") {
        ApiError::not_found().into_response()
    } else {
        page_not_found()
    }
}

fn page_not_found() -> Response {
    with_page_cache((StatusCode::NOT_FOUND, Html(assets::NOT_FOUND_HTML)).into_response())
}

fn with_page_cache(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response
}

async fn security_headers(request: Request, next: Next) -> Response {
    let is_api = request.uri().path().starts_with("/api/");
    let allows_updates = request.uri().path() == "/version";
    let is_mutation = !matches!(request.method().as_str(), "GET" | "HEAD" | "OPTIONS");
    let blocked_cross_origin = is_api && is_mutation && !is_same_origin(&request);

    let mut response = if blocked_cross_origin {
        ApiError::forbidden("cross-origin requests are not allowed").into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();

    headers.insert(
        HeaderName::from_static("content-security-policy"),
        content_security_policy(allows_updates),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), geolocation=(), microphone=()"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );

    if is_api {
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }

    response
}

/// Reject state-changing browser requests that come from another origin. This
/// keeps a malicious website from quietly creating or deleting documents on a
/// local Grapho instance. Non-browser clients such as curl do not send an
/// Origin header and are unaffected.
fn is_same_origin(request: &Request) -> bool {
    let Some(origin) = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
    else {
        return true;
    };

    let Some((_scheme, authority)) = origin.split_once("://") else {
        return false;
    };
    let origin_host = authority.trim_end_matches('/');

    let Some(host) = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };

    origin_host.eq_ignore_ascii_case(host)
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn not_found() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: "not found".to_owned(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::CONFLICT,
            message: message.into(),
        }
    }

    fn bad_gateway(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            message: message.into(),
        }
    }

    fn too_many_requests(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            message: message.into(),
        }
    }

    fn server_error(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

impl fmt::Debug for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ApiError")
            .field("status", &self.status)
            .field("message", &self.message)
            .finish()
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        if matches!(error, StoreError::EmptyDraft) {
            return Self::bad_request("Add a title or some content before saving.");
        }
        if matches!(error, StoreError::WrongDocumentFormat) {
            return Self {
                status: StatusCode::CONFLICT,
                message: "This document uses a different format.".to_owned(),
            };
        }
        if matches!(error, StoreError::InvalidDrawing) {
            return Self::bad_request("The drawing contains invalid pencil strokes.");
        }
        if matches!(error, StoreError::UnknownSpace) {
            return Self::bad_request("That Space doesn't exist.");
        }
        if matches!(error, StoreError::UnavailableSpace) {
            return Self {
                status: StatusCode::SERVICE_UNAVAILABLE,
                message: "This Space's storage folder is unavailable. Reconnect the folder, then restart Grapho.".to_owned(),
            };
        }
        eprintln!("document store error: {error}");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: "Grapho couldn't complete that change.".to_owned(),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            [(header::CACHE_CONTROL, "no-store")],
            Json(ErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::password_hash::PasswordHasher;
    use argon2::{Algorithm, Argon2, Params, Version};
    use std::path::PathBuf;
    use tower::ServiceExt;

    use crate::backup::BackupMirror;
    use crate::store::Store;

    fn test_hash(password: &str) -> String {
        // Cheap parameters: these tests exercise the gate's bookkeeping, not
        // Argon2's cost, and the real defaults are covered in `auth`'s tests.
        let params = Params::new(8, 1, 1, None).expect("cheap argon2 parameters");
        Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
            .hash_password(password.as_bytes())
            .expect("test password hashes")
            .to_string()
    }

    pub(super) async fn test_app(password: Option<&str>) -> (Router, PathBuf) {
        test_app_with_drive(password, Drive::new()).await
    }

    pub(super) async fn test_app_with_drive(
        password: Option<&str>,
        drive: Drive,
    ) -> (Router, PathBuf) {
        let (app, directory, _) = test_app_with_mirror(password, drive).await;
        (app, directory)
    }

    async fn test_app_with_mirror(
        password: Option<&str>,
        drive: Drive,
    ) -> (Router, PathBuf, Arc<BackupMirror>) {
        let directory = std::env::temp_dir().join(format!("grapho-api-test-{}", Uuid::new_v4()));
        let (app, backups) = test_app_for_directory(&directory, password, drive).await;
        (app, directory, backups)
    }

    async fn test_app_for_directory(
        directory: &std::path::Path,
        password: Option<&str>,
        drive: Drive,
    ) -> (Router, Arc<BackupMirror>) {
        let store = Arc::new(
            Store::load(directory.to_owned())
                .await
                .expect("test store loads"),
        );
        let auth = password.map(|password| Arc::new(Auth::new(test_hash(password)).expect("hash")));
        let settings_file = directory.join("test-settings.json");
        let drive = Arc::new(drive);
        let secrets = Arc::new(Secrets::load(Some(directory.join("test-secrets.json"))));
        let backups = BackupMirror::start(
            store.clone(),
            Vec::new(),
            drive.clone(),
            secrets.clone(),
            None,
        );
        (
            router(
                store,
                auth,
                ServerOptions {
                    data_dir_source: Source::Default,
                    settings_file: Some(settings_file),
                    backups: backups.clone(),
                    drive,
                    secrets,
                },
            ),
            backups,
        )
    }

    pub(super) fn get(uri: &str) -> Request {
        Request::builder()
            .uri(uri)
            .header(header::HOST, "127.0.0.1:25265")
            .body(Body::empty())
            .expect("valid test request")
    }

    /// The address the test requests claim to come from. Login is throttled per
    /// address, so every request to `/api/session` carries one.
    fn test_peer() -> SocketAddr {
        SocketAddr::from(([203, 0, 113, 9], 51515))
    }

    fn login_request(password: &str) -> Request {
        login_request_from(password, test_peer())
    }

    fn login_request_from(password: &str, peer: SocketAddr) -> Request {
        let mut request = Request::builder()
            .method("POST")
            .uri("/api/session")
            .header(header::HOST, "127.0.0.1:25265")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({ "password": password }).to_string(),
            ))
            .expect("valid test request");
        request.extensions_mut().insert(ConnectInfo(peer));
        request
    }

    fn logout_request(cookie: &str) -> Request {
        let mut request = Request::builder()
            .method("DELETE")
            .uri("/api/session")
            .header(header::HOST, "127.0.0.1:25265")
            .body(Body::empty())
            .expect("valid test request");
        with_cookie(&mut request, cookie);
        request
    }

    fn with_cookie(request: &mut Request, cookie: &str) {
        request.headers_mut().insert(
            header::COOKIE,
            HeaderValue::from_str(cookie).expect("cookie value"),
        );
    }

    fn session_cookie_of(response: &Response) -> String {
        response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .expect("a session cookie")
            .split(';')
            .next()
            .expect("the cookie pair")
            .to_owned()
    }

    #[tokio::test]
    async fn spelling_words_are_shared_persisted_and_deduplicated() {
        const WORDS: &str = "/api/spelling/words";
        let (app, directory) = test_app(None).await;
        let words = app.clone().oneshot(get(WORDS)).await.unwrap();
        assert_eq!(json_body(words).await, serde_json::json!([]));

        let (first, second) = tokio::join!(
            app.clone()
                .oneshot(post_json(WORDS, serde_json::json!({ "word": "Grapho" }))),
            app.clone().oneshot(post_json(
                WORDS,
                serde_json::json!({ "word": "Neuraspace" })
            )),
        );
        assert_eq!(first.unwrap().status(), StatusCode::OK);
        assert_eq!(second.unwrap().status(), StatusCode::OK);

        let expected = serde_json::json!(["grapho", "neuraspace"]);
        let duplicate = app
            .clone()
            .oneshot(post_json(WORDS, serde_json::json!({ "word": "GRAPHO" })))
            .await
            .unwrap();
        assert_eq!(json_body(duplicate).await, expected);
        let invalid = app
            .clone()
            .oneshot(post_json(WORDS, serde_json::json!({ "word": "two words" })))
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            json_body(app.oneshot(get(WORDS)).await.unwrap()).await,
            expected
        );

        let reopened = Store::load(directory.clone()).await.unwrap();
        let target = directory.join("moved");
        reopened.relocate(target.clone()).await.unwrap();
        let moved = Store::load(target).await.unwrap();
        assert_eq!(
            serde_json::to_value(moved.spelling_words().await.unwrap()).unwrap(),
            expected
        );
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    pub(super) async fn json_body(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("response body");
        serde_json::from_slice(&bytes).expect("json body")
    }

    #[tokio::test]
    async fn opening_a_draft_writes_a_file_only_on_its_first_meaningful_save() {
        let (app, directory) = test_app(Some("a password long enough")).await;
        let mut request = get("/doc/new");
        let response = app.clone().oneshot(get("/doc/new")).await.unwrap();
        assert_eq!(
            response.headers()[header::LOCATION],
            "/login?next=%2Fdoc%2Fnew"
        );

        let response = app
            .clone()
            .oneshot(login_request("a password long enough"))
            .await
            .unwrap();
        let cookie = session_cookie_of(&response);
        with_cookie(&mut request, &cookie);
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let draft = response.headers()[header::LOCATION].to_str().unwrap();
        let id = draft.strip_prefix("/doc/new/").unwrap();

        let mut request = get(draft);
        with_cookie(&mut request, &cookie);
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let file = directory.join("Title only.md");
        let endpoint = format!("/api/documents/{id}/draft");
        let mut request = put_json(&endpoint, serde_json::json!({}));
        with_cookie(&mut request, &cookie);
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!file.exists());

        let mut request = put_json(&endpoint, serde_json::json!({ "title": "Title only" }));
        with_cookie(&mut request, &cookie);
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let document = json_body(response).await;
        assert_eq!(document["id"], id);
        assert_eq!(document["title"], "Title only");
        assert_eq!(document["content"], "");
        assert!(file.is_file());

        let mut request = get(draft);
        with_cookie(&mut request, &cookie);
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers()[header::LOCATION], format!("/doc/{id}"));
        tokio::fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn boards_keep_their_markdown_through_saves_and_reopening() {
        use serde_json::json;
        use tokio::fs;

        let (app, directory) = test_app(None).await;
        let draft = app.clone().oneshot(get("/board/new")).await.unwrap();
        let draft_path = draft.headers()[header::LOCATION].to_str().unwrap();
        let id: Uuid = draft_path
            .strip_prefix("/board/new/")
            .unwrap()
            .parse()
            .unwrap();
        let document_path = format!("/doc/{id}");
        let api_path = format!("/api/documents/{id}");
        let board_path = format!("{api_path}/board");
        let create_path = format!("{board_path}?draft=true");
        let source = "# **Release board**\r\n\r\nPrepare the release.\r\n\r\n## To do\r\n    - Review:\r\n    ```\r\n        Find the release checklist.\r\n    ```\r\n\r\n## Done\r\n";
        let file = directory.join("Release board.md");
        let request = |request| async { app.clone().oneshot(request).await.unwrap() };

        assert_eq!(request(get(draft_path)).await.status(), StatusCode::OK);
        assert!(!file.exists());
        assert_eq!(
            request(put_json(&board_path, json!({ "markdown": source })))
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
        for _ in 0..2 {
            let saved = request(put_json(&create_path, json!({ "markdown": source }))).await;
            assert_eq!(saved.status(), StatusCode::OK);
            assert_eq!(
                json_body(saved).await,
                json!({ "title": "Release board", "markdown": source })
            );
        }
        assert_eq!(fs::read_to_string(&file).await.unwrap(), source);
        let document = request(get(&document_path)).await;
        let html = axum::body::to_bytes(document.into_body(), 1 << 20)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&html).contains("id=\"boardSource\""));
        assert_eq!(
            request(get(draft_path)).await.headers()[header::LOCATION],
            document_path
        );
        assert_eq!(
            request(put_json(
                &api_path,
                json!({ "content": "<p>Other editor</p>" })
            ))
            .await
            .status(),
            StatusCode::CONFLICT
        );

        let reopened = Store::load(directory.clone()).await.unwrap();
        assert_eq!(
            reopened.get(id).await.unwrap().board_markdown.as_deref(),
            Some(source)
        );
        assert_eq!(reopened.search("release checklist", None).await.len(), 1);
        let listing = json_body(request(get("/api/documents")).await).await;
        assert_eq!(listing["documents"][0]["board"], true);
        let results =
            json_body(request(get("/api/documents/search?q=release%20checklist")).await).await;
        assert_eq!(results["matches"][0]["board"], true);
        let renamed = request(put_json(&api_path, json!({ "title": "Next release" }))).await;
        assert_eq!(renamed.status(), StatusCode::OK);
        let current = json_body(request(get(&board_path)).await).await;
        let renamed_source = source.replacen("# **Release board**", "# Next release", 1);
        assert_eq!(current["markdown"], renamed_source);
        assert_eq!(
            fs::read_to_string(directory.join("Next release.md"))
                .await
                .unwrap(),
            renamed_source
        );
        let copy =
            json_body(request(post_json(&format!("{api_path}/duplicate"), json!({}))).await).await;
        assert_eq!(copy["board"], true);
        let copy_id = copy["id"].as_str().unwrap();
        let copy = json_body(request(get(&format!("/api/documents/{copy_id}/board"))).await).await;
        assert_eq!(
            copy["markdown"],
            renamed_source.replacen("# Next release", "# Next release (copy)", 1)
        );
        fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn drawings_round_trip_as_library_documents() {
        use serde_json::json;
        use tokio::fs;

        let (app, directory) = test_app(None).await;
        let request = |request| async { app.clone().oneshot(request).await.unwrap() };
        let draft = request(get("/draw/new?space=general")).await;
        let draft_path = draft.headers()[header::LOCATION].to_str().unwrap();
        let id: Uuid = draft_path
            .strip_prefix("/draw/new/")
            .unwrap()
            .strip_suffix("?space=general")
            .unwrap()
            .parse()
            .unwrap();
        let api_path = format!("/api/documents/{id}");
        let drawing_path = format!("{api_path}/drawing");
        let create_path = format!("{drawing_path}?draft=true");
        let drawing =
            json!({ "title": "Pencil sketch", "strokes": [[[0, 22], [1000, 50]], [[28, 42]]] });

        assert_eq!(request(get(draft_path)).await.status(), StatusCode::OK);
        for invalid in [
            json!({ "title": "Untitled drawing", "strokes": [] }),
            json!({ "title": "Pencil sketch", "strokes": [[[1001, 0]]] }),
            json!({ "title": "Pencil sketch", "strokes": [[]] }),
        ] {
            assert_eq!(
                request(put_json(&create_path, invalid)).await.status(),
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            request(get(&drawing_path)).await.status(),
            StatusCode::NOT_FOUND
        );
        for _ in 0..2 {
            assert_eq!(
                json_body(request(put_json(&create_path, drawing.clone())).await).await,
                drawing["title"]
            );
        }
        let response = request(get(&format!("/doc/{id}"))).await;
        let html = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        assert!(String::from_utf8_lossy(&html).contains("id=\"drawingCanvas\""));
        assert_eq!(json_body(request(get(&drawing_path)).await).await, drawing);
        assert_eq!(
            request(put_json(
                &api_path,
                json!({ "content": "<p>Other editor</p>" })
            ))
            .await
            .status(),
            StatusCode::CONFLICT
        );

        let renamed = request(put_json(&api_path, json!({ "title": "In the library" }))).await;
        assert_eq!(renamed.status(), StatusCode::OK);
        let listing =
            json_body(request(get("/api/documents/search?q=in%20the%20library")).await).await;
        assert_eq!(listing["matches"][0]["drawing"], true);
        assert_eq!(listing["matches"][0]["word_count"], 0);
        let copy =
            json_body(request(post_json(&format!("{api_path}/duplicate"), json!({}))).await).await;
        assert_eq!(copy["drawing"], true);
        let copy_id = copy["id"].as_str().unwrap();
        let copy =
            json_body(request(get(&format!("/api/documents/{copy_id}/drawing"))).await).await;
        assert_eq!(copy["title"], "In the library (copy)");
        assert_eq!(copy["strokes"], drawing["strokes"]);
        assert_eq!(
            request(delete_request(&api_path)).await.status(),
            StatusCode::NO_CONTENT
        );
        assert_eq!(
            request(get(&drawing_path)).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            request(post_json(&format!("{api_path}/restore"), json!({})))
                .await
                .status(),
            StatusCode::OK
        );

        let reopened = Store::load(directory.clone()).await.unwrap();
        let restored = reopened.get(id).await.unwrap();
        assert_eq!(restored.title, "In the library");
        let source = restored.drawing_markdown.unwrap();
        assert_eq!(
            source,
            "```grapho-drawing-v1\n[[[0,22],[1000,50]],[[28,42]]]\n```\n"
        );
        let mirror = reopened.backup_snapshot(None).await.unwrap();
        assert_eq!(mirror.files[&format!("{id}.md")], source.as_bytes());
        fs::remove_dir_all(directory).await.unwrap();
    }

    #[tokio::test]
    async fn private_routes_ask_for_a_password() {
        let (app, directory) = test_app(Some("a password long enough")).await;

        for path in [
            "/api/documents",
            "/api/documents/search?q=notes",
            "/api/documents/deleted",
            "/api/documents/3f0b3b0a-0c5a-4b8f-9a55-0d1f3b8a0000/title",
            "/api/documents/3f0b3b0a-0c5a-4b8f-9a55-0d1f3b8a0000/board",
            "/api/documents/3f0b3b0a-0c5a-4b8f-9a55-0d1f3b8a0000/drawing",
        ] {
            let response = app.clone().oneshot(get(path)).await.unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            assert_eq!(
                response.headers().get(header::CACHE_CONTROL).unwrap(),
                "no-store"
            );
        }

        let response = app
            .clone()
            .oneshot(get("/doc/3f0b3b0a-0c5a-4b8f-9a55-0d1f3b8a0000"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response.headers().get(header::LOCATION).unwrap(),
            "/login?next=%2Fdoc%2F3f0b3b0a-0c5a-4b8f-9a55-0d1f3b8a0000"
        );

        let response = app.clone().oneshot(get("/storage")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response.headers().get(header::LOCATION).unwrap(),
            "/login?next=%2Fstorage"
        );

        let response = app.clone().oneshot(get("/shortcuts")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(
            response.headers().get(header::LOCATION).unwrap(),
            "/login?next=%2Fshortcuts"
        );

        let response = app.clone().oneshot(get("/api/storage")).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/storage/spaces",
                serde_json::json!({ "name": "Work" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let duplicate = Request::builder()
            .method("POST")
            .uri("/api/documents/3f0b3b0a-0c5a-4b8f-9a55-0d1f3b8a0000/duplicate")
            .header(header::HOST, "127.0.0.1:25265")
            .body(Body::empty())
            .expect("valid test request");
        let response = app.clone().oneshot(duplicate).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn the_login_page_is_served_only_when_there_is_a_password() {
        let (app, directory) = test_app(Some("a password long enough")).await;

        let response = app.clone().oneshot(get("/login")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );

        let _ = tokio::fs::remove_dir_all(directory).await;

        let (app, directory) = test_app(None).await;
        let response = app.clone().oneshot(get("/login")).await.unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers().get(header::LOCATION).unwrap(), "/");

        let response = app.oneshot(get("/api/documents")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_body(response).await["auth_required"], false);

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn the_version_page_is_public_and_reports_the_build() {
        let (app, directory) = test_app(Some("a password long enough")).await;

        let response = app.oneshot(get("/version")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );

        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("response body");
        let body = String::from_utf8(bytes.to_vec()).expect("utf-8 page");
        assert!(body.contains(env!("CARGO_PKG_VERSION")));
        assert!(!body.contains("{{"), "every placeholder is replaced");

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn only_the_version_page_may_reach_github() {
        let (app, directory) = test_app(None).await;

        let response = app.clone().oneshot(get("/version")).await.unwrap();
        let policy = response
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(policy.contains("connect-src 'self' https://api.github.com;"));

        let response = app.oneshot(get("/assets/app.css")).await.unwrap();
        let policy = response
            .headers()
            .get("content-security-policy")
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(policy.contains("connect-src 'self';"));
        assert!(!policy.contains("api.github.com"));

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn the_right_password_opens_the_library_and_sign_out_closes_it() {
        let (app, directory) = test_app(Some("a password long enough")).await;

        let response = app
            .clone()
            .oneshot(login_request("a password long enough"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let set_cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(set_cookie.contains("HttpOnly"));
        assert!(set_cookie.contains("SameSite=Strict"));
        assert!(!set_cookie.contains("Secure"), "plain HTTP test request");
        let cookie = session_cookie_of(&response);

        let mut request = get("/api/documents");
        with_cookie(&mut request, &cookie);
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::VARY).unwrap(),
            "Cookie",
            "a cached copy must not be served to another browser"
        );
        assert_eq!(json_body(response).await["auth_required"], true);

        let response = app.clone().oneshot(logout_request(&cookie)).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers().get(header::SET_COOKIE).unwrap(),
            "grapho_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"
        );

        let mut request = get("/api/documents");
        with_cookie(&mut request, &cookie);
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn a_wrong_password_is_refused_without_a_cookie() {
        let (app, directory) = test_app(Some("a password long enough")).await;

        let response = app
            .clone()
            .oneshot(login_request("not the password"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        assert_eq!(
            json_body(response).await["error"],
            "That password is not correct."
        );

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn repeated_wrong_passwords_pause_logins() {
        let (app, directory) = test_app(Some("a password long enough")).await;

        for attempt in 0..auth::MAX_FAILED_LOGINS {
            let response = app
                .clone()
                .oneshot(login_request("not the password"))
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::UNAUTHORIZED,
                "attempt {attempt}"
            );
        }

        let response = app
            .clone()
            .oneshot(login_request("not the password"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let retry_after: u64 = response
            .headers()
            .get(header::RETRY_AFTER)
            .expect("a Retry-After header")
            .to_str()
            .unwrap()
            .parse()
            .expect("whole seconds");
        assert!((1..=auth::LOGIN_WINDOW.as_secs()).contains(&retry_after));

        // The pause covers the right password too: nothing is verified while it
        // lasts, so no session starts.
        let response = app
            .oneshot(login_request("a password long enough"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().get(header::SET_COOKIE).is_none());

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn one_address_cannot_pause_another() {
        let (app, directory) = test_app(Some("a password long enough")).await;
        let attacker = SocketAddr::from(([203, 0, 113, 9], 40000));
        let owner = SocketAddr::from(([203, 0, 113, 10], 40001));

        for _ in 0..auth::MAX_FAILED_LOGINS {
            let response = app
                .clone()
                .oneshot(login_request_from("not the password", attacker))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }

        // Guessing pauses only the address it came from, so the owner signing in
        // from somewhere else still works.
        let response = app
            .clone()
            .oneshot(login_request_from("not the password", attacker))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);

        let response = app
            .clone()
            .oneshot(login_request_from("a password long enough", owner))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(response.headers().get(header::SET_COOKIE).is_some());

        // The pause still covers the attacker's own correct password.
        let response = app
            .oneshot(login_request_from("a password long enough", attacker))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert!(response.headers().get(header::SET_COOKIE).is_none());

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn a_cross_site_login_attempt_is_refused() {
        let (app, directory) = test_app(Some("a password long enough")).await;

        let mut request = login_request("a password long enough");
        request.headers_mut().insert(
            header::ORIGIN,
            HeaderValue::from_static("https://evil.example"),
        );

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn a_login_body_cannot_be_large() {
        let (app, directory) = test_app(Some("a password long enough")).await;

        let mut request = Request::builder()
            .method("POST")
            .uri("/api/session")
            .header(header::HOST, "127.0.0.1:25265")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(format!(
                "{{\"password\":\"{}\"}}",
                "a".repeat(LOGIN_BODY_LIMIT_BYTES * 2)
            )))
            .expect("valid test request");
        request.extensions_mut().insert(ConnectInfo(test_peer()));

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    fn mutation_with_origin(origin: Option<&str>) -> Request {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/documents")
            .header(header::HOST, "127.0.0.1:25265");
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        builder.body(Body::empty()).expect("valid test request")
    }

    #[test]
    fn a_login_redirect_keeps_the_destination_in_one_value() {
        let request = Request::builder()
            .uri("/doc/abc?tab=notes&sort=title")
            .body(Body::empty())
            .expect("valid test request");
        assert_eq!(
            login_location(&request),
            "/login?next=%2Fdoc%2Fabc%3Ftab%3Dnotes%26sort%3Dtitle"
        );

        let root = Request::builder()
            .uri("/")
            .body(Body::empty())
            .expect("valid test request");
        assert_eq!(login_location(&root), "/login");
    }

    #[test]
    fn same_origin_mutations_are_allowed() {
        assert!(is_same_origin(&mutation_with_origin(None)));
        assert!(is_same_origin(&mutation_with_origin(Some(
            "http://127.0.0.1:25265"
        ))));
    }

    #[test]
    fn cross_origin_mutations_are_refused() {
        assert!(!is_same_origin(&mutation_with_origin(Some(
            "https://evil.example"
        ))));
        assert!(!is_same_origin(&mutation_with_origin(Some("null"))));
        assert!(!is_same_origin(&mutation_with_origin(Some(
            "http://127.0.0.1:9999"
        ))));
    }

    #[tokio::test]
    async fn an_unreachable_space_is_reported_without_blocking_the_library() {
        use serde_json::json;

        let (app, root) = test_app(None).await;
        let desktop = root.join("desktop");
        let reachable = root.join("reachable");
        for (name, folder) in [("Desktop", &desktop), ("Reachable", &reachable)] {
            let response = app
                .clone()
                .oneshot(post_json(
                    "/api/storage/spaces",
                    json!({ "name": name, "folder": folder }),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CREATED);
        }

        let storage = json_body(app.clone().oneshot(get("/api/storage")).await.unwrap()).await;
        let desktop_id = storage["spaces"][0]["id"].as_str().unwrap();
        let reachable_id = storage["spaces"][1]["id"].as_str().unwrap();
        let offline_id = Uuid::new_v4();
        let reachable_doc = Uuid::new_v4();
        for (space, doc) in [(desktop_id, offline_id), (reachable_id, reachable_doc)] {
            let response = app
                .clone()
                .oneshot(put_json(
                    &format!("/api/documents/{doc}/draft?space={space}"),
                    json!({ "title": "Project notes", "content": "<p>Original body</p>" }),
                ))
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        drop(app);

        let disconnected = root.join("disconnected");
        tokio::fs::rename(&desktop, &disconnected).await.unwrap();
        let (app, _) = test_app_for_directory(&root, None, Drive::new()).await;
        let listing = json_body(app.clone().oneshot(get("/api/documents")).await.unwrap()).await;
        assert_eq!(listing["spaces"][0]["available"], false);
        assert_eq!(listing["spaces"][1]["available"], true);
        assert_eq!(listing["documents"].as_array().unwrap().len(), 1);
        assert_eq!(listing["documents"][0]["id"], reachable_doc.to_string());

        let storage = json_body(app.clone().oneshot(get("/api/storage")).await.unwrap()).await;
        assert_eq!(storage["spaces"][0]["available"], false);

        let doc_path = format!("/api/documents/{offline_id}");
        let response = app
            .clone()
            .oneshot(get(&format!("/doc/{offline_id}")))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "the editor can display the error"
        );
        for request in [
            get(&doc_path),
            get(&format!("/api/documents/search?q=notes&space={desktop_id}")),
            post_json(&format!("/api/documents?space={desktop_id}"), json!({})),
            put_json(
                &format!("{doc_path}/draft"),
                json!({ "title": "An old tab's edit" }),
            ),
            put_json(
                &format!("/api/storage/spaces/{desktop_id}"),
                json!({ "name": "Desktop", "folder": desktop }),
            ),
            put_json(
                &format!("/api/documents/{reachable_doc}/space"),
                json!({ "space_id": desktop_id }),
            ),
        ] {
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert!(json_body(response).await["error"]
                .as_str()
                .unwrap()
                .contains("storage folder is unavailable"));
        }
        let response = app
            .oneshot(post_json("/api/documents", json!({})))
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::CREATED,
            "General is still writable"
        );
        assert!(
            !desktop.exists(),
            "a save must not recreate the missing folder"
        );

        // An unmounted share can also leave an empty mount point behind.
        tokio::fs::create_dir(&desktop).await.unwrap();
        let (app, _) = test_app_for_directory(&root, None, Drive::new()).await;
        let response = app.oneshot(get(&doc_path)).await.unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        tokio::fs::remove_dir(&desktop).await.unwrap();
        tokio::fs::rename(&disconnected, &desktop).await.unwrap();

        let (app, _) = test_app_for_directory(&root, None, Drive::new()).await;
        let document = json_body(app.oneshot(get(&doc_path)).await.unwrap()).await;
        assert_eq!(document["space_id"], desktop_id);
        assert_eq!(document["content"], "<p>Original body</p>");
        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn space_folders_keep_documents_searchable_and_mirrored() {
        use serde_json::json;

        let (app, root, mirror) = test_app_with_mirror(None, Drive::new()).await;
        let folder = root.with_extension("work");
        let new_folder = root.join("project");
        let backup = std::env::temp_dir().join(format!("grapho-space-backup-{}", Uuid::new_v4()));
        let request =
            |request| async { json_body(app.clone().oneshot(request).await.unwrap()).await };

        let document = request(post_json("/api/documents", json!({}))).await;
        let id = document["id"].as_str().unwrap();
        let doc_path = format!("/api/documents/{id}");
        let body = "Project brief.md";
        let image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/1i9fWwAAAABJRU5ErkJggg==";
        let document = request(put_json(
            &doc_path,
            json!({ "title": "Project brief", "content": format!("<p>shared phrase</p><p><img src=\"{image}\" alt=\"diagram\"></p>") }),
        )).await;
        assert!(document["space_id"].is_null());
        assert!(root.join(body).is_file());

        let storage = request(post_json("/api/storage/spaces", json!({ "name": "Work" }))).await;
        let space = storage["spaces"][0]["id"].as_str().unwrap();
        let space_path = format!("/api/storage/spaces/{space}");
        let move_path = format!("{doc_path}/space");
        let moved = request(put_json(&move_path, json!({ "space_id": space }))).await;
        assert_eq!(moved["id"], id);
        assert_eq!(moved["space_id"], space);
        assert_eq!(moved["updated_at"], document["updated_at"]);
        assert!(root.join(body).is_file());

        let storage = request(put_json(
            &space_path,
            json!({ "name": "Work", "folder": folder }),
        ))
        .await;
        assert_eq!(storage["spaces"][0]["folder"], json!(folder));
        assert!(!root.join(body).exists());
        let source = std::fs::read_to_string(folder.join(body)).unwrap();
        assert!(source.contains("shared phrase") && !source.contains("data:image"));
        let general = request(get("/api/documents/search?q=shared+phrase&space=general")).await;
        assert_eq!(general["matches"], json!([]));
        let work = request(get(&format!(
            "/api/documents/search?q=shared+phrase&space={space}"
        )))
        .await;
        assert_eq!(work["matches"][0]["id"], id);

        let draft_id = Uuid::new_v4();
        let draft = request(put_json(
            &format!("/api/documents/{draft_id}/draft?space={space}"),
            json!({ "title": "Work notes" }),
        ))
        .await;
        assert_eq!(draft["space_id"], space);
        assert!(folder.join("Work notes.md").is_file());

        let copy = request(post_json(&format!("{doc_path}/duplicate"), json!({}))).await;
        let copy_id = copy["id"].as_str().unwrap();
        let copy_file = "Project brief (copy).md";
        assert_eq!(copy["space_id"], space);
        assert!(folder.join(copy_file).is_file());
        let deleted = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/api/documents/{copy_id}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);

        let conflict = app
            .clone()
            .oneshot(post_json("/api/storage/backups", json!({ "path": folder })))
            .await
            .unwrap();
        assert!(!conflict.status().is_success());
        let storage = request(post_json("/api/storage/backups", json!({ "path": backup }))).await;
        assert_eq!(storage["backups"].as_array().unwrap().len(), 1);

        let changed = request(put_json(
            &space_path,
            json!({ "name": "Project", "folder": new_folder }),
        ))
        .await;
        assert_eq!(changed["spaces"][0]["name"], "Project");
        assert!(new_folder.join(copy_file).is_file());
        assert!(
            folder.join(body).is_file(),
            "the previous custom folder keeps its copy"
        );
        let reopened = Store::load(root.clone()).await.unwrap();
        let reopened_doc = reopened.get(id.parse().unwrap()).await.unwrap();
        assert_eq!(reopened_doc.space_id, Some(space.parse().unwrap()));
        assert!(reopened_doc.content.contains(image));
        assert_eq!(reopened.list_deleted().await.len(), 1);

        assert!(mirror.flush(Duration::from_secs(3)).await);
        let recovered = Store::load(backup.clone()).await.unwrap();
        let recovered_doc = recovered.get(id.parse().unwrap()).await.unwrap();
        assert_eq!(recovered_doc.space_id, reopened_doc.space_id);
        assert_eq!(recovered_doc.content, reopened_doc.content);
        let spaces = recovered.spaces().await;
        assert_eq!(spaces[0].1.name, "Project");
        assert_eq!(spaces[0].1.folder, None);
        assert!(!backup.join(copy_file).exists());

        let moved_back = request(put_json(&move_path, json!({ "space_id": null }))).await;
        assert_eq!(moved_back["id"], id);
        assert!(moved_back["space_id"].is_null());
        assert!(root.join(body).is_file());
        assert!(!new_folder.join(body).exists());
        assert!(mirror.flush(Duration::from_secs(3)).await);
        let _ = tokio::fs::remove_dir_all(root).await;
        let _ = tokio::fs::remove_dir_all(folder).await;
        let _ = tokio::fs::remove_dir_all(backup).await;
    }

    #[tokio::test]
    async fn creating_a_space_imports_markdown_in_place_and_mirrors_the_batch() {
        use serde_json::json;
        use tokio::fs;

        let (app, root, mirror) = test_app_with_mirror(None, Drive::new()).await;
        let folder = root.join("notes");
        let backup = root.with_extension("backup");
        let source = "# Draft\r\n\r\nWork with **Grapho**.\r\n";
        fs::create_dir_all(folder.join("subfolder")).await.unwrap();
        fs::write(folder.join("Project notes.md"), source)
            .await
            .unwrap();
        fs::write(folder.join("Ideas.MD"), "Another idea.")
            .await
            .unwrap();
        fs::write(folder.join("subfolder").join("Nested.md"), "Nested")
            .await
            .unwrap();
        fs::write(folder.join("Readme.txt"), "Other file")
            .await
            .unwrap();
        let response = app
            .clone()
            .oneshot(post_json("/api/storage/backups", json!({ "path": backup })))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/storage/spaces",
                json!({ "name": "Notes", "folder": folder, "import_markdown": true }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let storage = json_body(response).await;
        assert_eq!(storage["imported_documents"], 2);
        assert_eq!(storage["documents"], 2);
        let space = storage["spaces"][0]["id"].as_str().unwrap();
        let results = json_body(
            app.oneshot(get(&format!(
                "/api/documents/search?q=Work+with+Grapho&space={space}"
            )))
            .await
            .unwrap(),
        )
        .await;
        let matches = results["matches"].as_array().unwrap();
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0]["title"], "Project notes");
        let id: Uuid = matches[0]["id"].as_str().unwrap().parse().unwrap();
        assert_eq!(
            fs::read_to_string(folder.join("Project notes.md"))
                .await
                .unwrap(),
            source
        );

        let reopened = Store::load(root.clone()).await.unwrap();
        let document = reopened.get(id).await.unwrap();
        assert_eq!(document.space_id, Some(space.parse().unwrap()));
        assert_eq!(
            document.content,
            "<h1>Draft</h1><p>Work with <b>Grapho</b>.</p>"
        );
        assert_eq!(reopened.list().await.len(), 2);

        assert!(mirror.flush(Duration::from_secs(3)).await);
        let mirrored = Store::load(backup.clone()).await.unwrap();
        assert_eq!(mirrored.list().await.len(), 2);
        assert_eq!(mirrored.get(id).await.unwrap().space_id, document.space_id);

        let updated = reopened
            .update(id, None, Some("<p>Updated in Grapho.</p>".to_owned()), None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.title, "Project notes");
        assert_eq!(
            fs::read_to_string(folder.join("Project notes.md"))
                .await
                .unwrap(),
            "Updated in Grapho.\n"
        );
        fs::remove_dir_all(root).await.unwrap();
        fs::remove_dir_all(backup).await.unwrap();
    }

    #[tokio::test]
    async fn import_is_optional_and_an_unreadable_markdown_file_leaves_no_partial_space() {
        use serde_json::json;
        use tokio::fs;

        let (app, root) = test_app(None).await;
        let folder = root.join("notes");
        fs::create_dir(&folder).await.unwrap();
        fs::write(folder.join("Notes.md"), "Existing text")
            .await
            .unwrap();
        fs::write(folder.join("Invalid.md"), [0xff]).await.unwrap();

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/storage/spaces",
                json!({ "name": "Notes", "folder": folder, "import_markdown": true }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(json_body(response).await["error"]
            .as_str()
            .unwrap()
            .contains("Invalid.md"));
        assert!(!root.join(crate::store::INDEX_FILE).exists());
        assert_eq!(
            fs::read_to_string(folder.join("Notes.md")).await.unwrap(),
            "Existing text"
        );

        let response = app
            .oneshot(post_json(
                "/api/storage/spaces",
                json!({ "name": "Notes", "folder": folder }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let storage = json_body(response).await;
        assert_eq!(storage["documents"], 0);
        assert_eq!(storage["spaces"].as_array().unwrap().len(), 1);
        assert!(storage.get("imported_documents").is_none());
        fs::remove_dir_all(root).await.unwrap();
    }

    fn put_json(uri: &str, body: serde_json::Value) -> Request {
        Request::builder()
            .method("PUT")
            .uri(uri)
            .header(header::HOST, "127.0.0.1:25265")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("valid test request")
    }

    pub(super) fn post_json(uri: &str, body: serde_json::Value) -> Request {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header(header::HOST, "127.0.0.1:25265")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("valid test request")
    }

    fn delete_request(uri: &str) -> Request {
        Request::builder()
            .method("DELETE")
            .uri(uri)
            .header(header::HOST, "127.0.0.1:25265")
            .body(Body::empty())
            .expect("valid test request")
    }

    pub(super) fn create_document_request() -> Request {
        Request::builder()
            .method("POST")
            .uri("/api/documents")
            .header(header::HOST, "127.0.0.1:25265")
            .body(Body::empty())
            .expect("valid test request")
    }

    fn duplicate_request(id: &str) -> Request {
        Request::builder()
            .method("POST")
            .uri(format!("/api/documents/{id}/duplicate"))
            .header(header::HOST, "127.0.0.1:25265")
            .body(Body::empty())
            .expect("valid test request")
    }

    /// The mirror runs in the background, so the test waits for the effect
    /// instead of assuming it already happened.
    async fn wait_for_file(path: &std::path::Path, wanted: &str) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if let Ok(text) = tokio::fs::read_to_string(path).await {
                if text.contains(wanted) {
                    return;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{} never contained {wanted:?}",
                path.display()
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    async fn wait_for_removal(path: &std::path::Path) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
        while path.exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "{} was never removed",
                path.display()
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    #[tokio::test]
    async fn regression_deleted_document_survives_moving_into_a_backup() {
        let (app, original, mirror) = test_app_with_mirror(None, Drive::new()).await;
        let backup_root =
            std::env::temp_dir().join(format!("grapho-move-backup-{}", Uuid::new_v4()));
        let backup = backup_root.join("copies");
        let folder = serde_json::json!({ "path": backup });
        let added = app
            .clone()
            .oneshot(post_json("/api/storage/backups", folder))
            .await
            .unwrap();
        assert_eq!(added.status(), StatusCode::OK);
        for target in [
            backup.clone(),
            backup.join("new-child"),
            backup_root.clone(),
        ] {
            let moved = app
                .clone()
                .oneshot(put_json(
                    "/api/storage",
                    serde_json::json!({ "path": target }),
                ))
                .await
                .unwrap();
            assert_eq!(moved.status(), StatusCode::BAD_REQUEST);
        }

        let storage = json_body(app.clone().oneshot(get("/api/storage")).await.unwrap()).await;
        let current = PathBuf::from(storage["path"].as_str().unwrap());
        assert_eq!(current, original);
        let id = Uuid::new_v4();
        let doc = format!("/api/documents/{id}");
        let created = app
            .clone()
            .oneshot(put_json(
                &format!("{doc}/draft"),
                serde_json::json!({
                    "title": "After moving", "content": "<p>Keep this writing.</p>"
                }),
            ))
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        assert!(mirror.flush(std::time::Duration::from_secs(5)).await);
        let deleted = app.oneshot(delete_request(&doc)).await.unwrap();
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        assert!(mirror.flush(std::time::Duration::from_secs(5)).await);

        let reopened = Store::load(current).await.unwrap();
        let restored = reopened.restore(id).await.unwrap();
        tokio::fs::remove_dir_all(original).await.unwrap();
        tokio::fs::remove_dir_all(backup_root).await.unwrap();
        assert_eq!(
            restored.as_ref().map(|doc| doc.content.as_str()),
            Some("<p>Keep this writing.</p>"),
            "Recently deleted must survive reopening the active data folder"
        );
    }

    #[tokio::test]
    async fn adding_a_backup_and_moving_into_it_cannot_both_succeed() {
        let (app, directory) = test_app(None).await;
        let target =
            std::env::temp_dir().join(format!("grapho-concurrent-move-{}", Uuid::new_v4()));
        let folder = serde_json::json!({ "path": target });
        let (adding, moving) = tokio::join!(
            app.clone()
                .oneshot(post_json("/api/storage/backups", folder.clone())),
            app.oneshot(put_json("/api/storage", folder))
        );
        let statuses = [adding.unwrap().status(), moving.unwrap().status()];
        assert!(
            statuses.contains(&StatusCode::OK) && statuses.contains(&StatusCode::BAD_REQUEST),
            "{statuses:?}"
        );
        tokio::fs::remove_dir_all(directory).await.unwrap();
        tokio::fs::remove_dir_all(target).await.unwrap();
    }

    #[tokio::test]
    async fn the_storage_page_reports_where_documents_live() {
        let (app, directory) = test_app(None).await;

        let response = app.clone().oneshot(get("/storage")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );

        let response = app.clone().oneshot(get("/api/storage")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );

        let body = json_body(response).await;
        assert_eq!(body["path"], directory.display().to_string());
        assert_eq!(body["source"], "default");
        assert_eq!(body["editable"], true);
        assert_eq!(body["documents"], 0);
        assert_eq!(body["bytes"], 0);

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn the_shortcuts_page_lists_the_editor_and_the_rest() {
        let (app, directory) = test_app(None).await;

        let response = app.clone().oneshot(get("/shortcuts")).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-cache"
        );

        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("response body");
        let body = String::from_utf8(bytes.to_vec()).expect("utf-8 page");
        assert!(body.contains("id=\"editorShortcutsTitle\""));
        assert!(body.contains("id=\"otherShortcutsTitle\""));
        assert!(body.contains("<kbd>Ctrl+S</kbd>"));
        // The library and editor menus link to the page in their own markup.
        assert!(assets::INDEX_HTML.contains("href=\"/shortcuts\""));
        assert!(assets::EDITOR_HTML.contains("href=\"/shortcuts\""));

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn a_storage_change_copies_the_documents_and_is_remembered() {
        let (app, directory) = test_app(None).await;
        let target = std::env::temp_dir().join(format!("grapho-api-move-{}", Uuid::new_v4()));

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/documents")
                    .header(header::HOST, "127.0.0.1:25265")
                    .body(Body::empty())
                    .expect("valid test request"),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let response = app
            .clone()
            .oneshot(put_json(
                "/api/storage",
                serde_json::json!({ "path": target.display().to_string() }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = json_body(response).await;
        assert_eq!(body["path"], target.display().to_string());
        assert_eq!(
            body["source"], "settings",
            "the page reports the choice it just saved"
        );
        assert_eq!(body["documents"], 1);
        assert!(target.join("Untitled document.md").exists());
        assert!(
            directory.join("Untitled document.md").exists(),
            "the old folder keeps its copy"
        );

        // The new folder is the one the next start will use.
        let saved = tokio::fs::read_to_string(directory.join("test-settings.json"))
            .await
            .expect("the choice is written down");
        let saved: serde_json::Value = serde_json::from_str(&saved).expect("settings json");
        assert_eq!(saved["data_dir"], target.display().to_string());

        // New documents land there too.
        app.clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/documents")
                    .header(header::HOST, "127.0.0.1:25265")
                    .body(Body::empty())
                    .expect("valid test request"),
            )
            .await
            .unwrap();
        let body = json_body(app.oneshot(get("/api/storage")).await.unwrap()).await;
        assert_eq!(body["documents"], 2);

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(target).await;
    }

    #[tokio::test]
    async fn a_storage_change_needs_a_usable_folder() {
        let (app, directory) = test_app(None).await;

        let response = app
            .clone()
            .oneshot(put_json(
                "/api/storage",
                serde_json::json!({ "path": "relative-folder" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let message = json_body(response).await["error"]
            .as_str()
            .expect("an error message")
            .to_owned();
        assert!(
            message.contains("full folder path"),
            "a relative path is explained: {message}"
        );

        let occupied = std::env::temp_dir().join(format!("grapho-api-full-{}", Uuid::new_v4()));
        Store::load(occupied.clone())
            .await
            .unwrap()
            .create()
            .await
            .unwrap();

        let response = app
            .clone()
            .oneshot(put_json(
                "/api/storage",
                serde_json::json!({ "path": occupied.display().to_string() }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(response).await["error"],
            "That folder already holds a document from another Grapho library. Choose an empty folder."
        );

        // Neither refusal moved the library.
        let body = json_body(app.oneshot(get("/api/storage")).await.unwrap()).await;
        assert_eq!(body["path"], directory.display().to_string());

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(occupied).await;
    }

    #[tokio::test]
    async fn the_environment_folder_cannot_be_changed_from_the_page() {
        let directory = std::env::temp_dir().join(format!("grapho-api-env-{}", Uuid::new_v4()));
        let store = Arc::new(
            Store::load(directory.clone())
                .await
                .expect("test store loads"),
        );
        let settings_file = directory.join("test-settings.json");
        let drive = Arc::new(Drive::new());
        let secrets = Arc::new(Secrets::load(Some(directory.join("test-secrets.json"))));
        let backups = BackupMirror::start(
            store.clone(),
            Vec::new(),
            drive.clone(),
            secrets.clone(),
            None,
        );
        let app = router(
            store,
            None,
            ServerOptions {
                data_dir_source: Source::Environment,
                settings_file: Some(settings_file),
                backups,
                drive,
                secrets,
            },
        );

        let body = json_body(app.clone().oneshot(get("/api/storage")).await.unwrap()).await;
        assert_eq!(body["source"], "environment");
        assert_eq!(body["editable"], false);

        let target = std::env::temp_dir().join(format!("grapho-api-env-move-{}", Uuid::new_v4()));
        let response = app
            .oneshot(put_json(
                "/api/storage",
                serde_json::json!({ "path": target.display().to_string() }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(!target.exists(), "nothing was created");

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn a_backup_folder_copies_the_library_and_is_remembered() {
        let (app, directory) = test_app(None).await;
        let target = std::env::temp_dir().join(format!("grapho-api-backup-{}", Uuid::new_v4()));

        let response = app
            .clone()
            .oneshot(create_document_request())
            .await
            .unwrap();
        let created = json_body(response).await;
        let id = created["id"].as_str().expect("a document id").to_owned();

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/storage/backups",
                serde_json::json!({ "path": target.display().to_string() }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = json_body(response).await;
        let backups = body["backups"].as_array().expect("a backup list");
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0]["path"], target.display().to_string());
        assert!(backups[0]["error"].is_null(), "the first copy worked");
        assert_eq!(body["backups_editable"], true);
        assert!(
            target.join(format!("{id}.md")).exists(),
            "the existing library was copied in"
        );

        let saved = tokio::fs::read_to_string(directory.join("test-settings.json"))
            .await
            .expect("the backup is written down");
        let saved: serde_json::Value = serde_json::from_str(&saved).expect("settings json");
        assert_eq!(saved["backups"].as_array().expect("backups").len(), 1);
        assert_eq!(saved["backups"][0]["path"], target.display().to_string());
        assert!(
            saved.get("data_dir").is_none(),
            "adding a backup does not pin the data folder"
        );

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(target).await;
    }

    #[tokio::test]
    async fn a_backup_folder_is_validated() {
        let (app, directory) = test_app(None).await;

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/storage/backups",
                serde_json::json!({ "path": "relative" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(json_body(response).await["error"]
            .as_str()
            .expect("a message")
            .contains("full folder path"));

        let inside = directory.join("inside-the-library");
        let response = app
            .clone()
            .oneshot(post_json(
                "/api/storage/backups",
                serde_json::json!({ "path": inside.display().to_string() }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            json_body(response).await["error"],
            "Choose a folder outside the data folder."
        );

        let target = std::env::temp_dir().join(format!("grapho-api-backup-dup-{}", Uuid::new_v4()));
        let request = || {
            post_json(
                "/api/storage/backups",
                serde_json::json!({ "path": target.display().to_string() }),
            )
        };
        let response = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app.clone().oneshot(request()).await.unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        assert_eq!(
            json_body(response).await["error"],
            "That backup already exists."
        );

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(target).await;
    }

    #[tokio::test]
    async fn removing_a_backup_keeps_the_copies_and_forgets_the_folder() {
        let (app, directory) = test_app(None).await;
        let target = std::env::temp_dir().join(format!("grapho-api-backup-rm-{}", Uuid::new_v4()));

        let response = app
            .clone()
            .oneshot(create_document_request())
            .await
            .unwrap();
        let id = json_body(response).await["id"]
            .as_str()
            .expect("a document id")
            .to_owned();

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/storage/backups",
                serde_json::json!({ "path": target.display().to_string() }),
            ))
            .await
            .unwrap();
        let body = json_body(response).await;
        let backup_id = body["backups"][0]["id"]
            .as_str()
            .expect("a backup id")
            .to_owned();

        let response = app
            .clone()
            .oneshot(delete_request(&format!("/api/storage/backups/{backup_id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(json_body(response).await["backups"]
            .as_array()
            .expect("backups")
            .is_empty());

        assert!(
            target.join(format!("{id}.md")).exists(),
            "removing a backup never deletes the copies"
        );
        let saved = tokio::fs::read_to_string(directory.join("test-settings.json"))
            .await
            .expect("the settings file");
        let saved: serde_json::Value = serde_json::from_str(&saved).expect("settings json");
        assert!(
            saved["backups"]
                .as_array()
                .is_none_or(|backups| backups.is_empty()),
            "the folder is forgotten"
        );

        let response = app
            .clone()
            .oneshot(delete_request(&format!("/api/storage/backups/{backup_id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(target).await;
    }

    #[tokio::test]
    async fn saves_deletes_and_restores_reach_the_backup_folder() {
        let (app, directory) = test_app(None).await;
        let target =
            std::env::temp_dir().join(format!("grapho-api-backup-live-{}", Uuid::new_v4()));

        let response = app
            .clone()
            .oneshot(create_document_request())
            .await
            .unwrap();
        let id = json_body(response).await["id"]
            .as_str()
            .expect("a document id")
            .to_owned();

        app.clone()
            .oneshot(post_json(
                "/api/storage/backups",
                serde_json::json!({ "path": target.display().to_string() }),
            ))
            .await
            .unwrap();

        let copied = target.join(format!("{id}.md"));
        let index = target.join(crate::store::INDEX_FILE);
        let response = app
            .clone()
            .oneshot(put_json(
                &format!("/api/documents/{id}"),
                serde_json::json!({ "title": "Mirrored", "content": "<p>Writing</p>" }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        wait_for_file(&copied, "Writing").await;
        wait_for_file(&index, "Mirrored").await;

        let response = app
            .clone()
            .oneshot(delete_request(&format!("/api/documents/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        wait_for_removal(&copied).await;

        let response = app
            .clone()
            .oneshot(get(&format!("/api/documents/{id}")))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        let body = json_body(
            app.clone()
                .oneshot(get("/api/documents/deleted"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(body["documents"][0]["id"], id);
        assert_eq!(body["documents"][0]["title"], "Mirrored");

        let response = app
            .clone()
            .oneshot(post_json(
                &format!("/api/documents/{id}/restore"),
                serde_json::json!({}),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(json_body(response).await["id"], id);
        wait_for_file(&copied, "Writing").await;
        wait_for_file(&index, "Mirrored").await;
        let body = json_body(app.oneshot(get("/api/documents/deleted")).await.unwrap()).await;
        assert_eq!(body["documents"], serde_json::json!([]));

        let _ = tokio::fs::remove_dir_all(directory).await;
        let _ = tokio::fs::remove_dir_all(target).await;
    }

    #[tokio::test]
    async fn a_duplicate_is_a_new_document_with_the_same_writing() {
        let (app, directory) = test_app(None).await;

        let response = app
            .clone()
            .oneshot(create_document_request())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let id = json_body(response).await["id"]
            .as_str()
            .expect("a document id")
            .to_owned();

        let response = app
            .clone()
            .oneshot(put_json(
                &format!("/api/documents/{id}"),
                serde_json::json!({
                    "title": "Field notes",
                    "content": "<p>One <b>two</b>.</p>",
                    "paper_width": 1180,
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app.clone().oneshot(duplicate_request(&id)).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );
        let copy = json_body(response).await;
        let copy_id = copy["id"].as_str().expect("a copy id").to_owned();
        assert_ne!(copy_id, id, "the copy is its own document");
        assert_eq!(copy["title"], "Field notes (copy)");
        // The answer is the shape the library listing uses, so the new card can
        // be drawn without asking for the listing again.
        assert_eq!(copy["excerpt"], "One two.");
        assert_eq!(copy["preview"], "<p>One <b>two</b>.</p>");
        assert_eq!(copy["word_count"], 2);

        let stored = json_body(
            app.clone()
                .oneshot(get(&format!("/api/documents/{copy_id}")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(stored["content"], "<p>One <b>two</b>.</p>");
        assert_eq!(stored["paper_width"], 1180);

        // The source keeps its own name, and the library lists both documents.
        let source = json_body(
            app.clone()
                .oneshot(get(&format!("/api/documents/{id}")))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(source["title"], "Field notes");
        let listing = json_body(app.clone().oneshot(get("/api/documents")).await.unwrap()).await;
        assert_eq!(
            listing["documents"]
                .as_array()
                .expect("a document list")
                .len(),
            2
        );

        // The copy is a file on disk like any other document.
        assert!(directory.join("Field notes (copy).md").exists());

        // An unknown document has nothing to copy.
        let response = app
            .oneshot(duplicate_request(&Uuid::new_v4().to_string()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn link_destinations_show_the_current_title_of_an_active_document() {
        let (app, directory) = test_app(None).await;
        let created = app
            .clone()
            .oneshot(create_document_request())
            .await
            .unwrap();
        let path = format!(
            "/api/documents/{}",
            json_body(created).await["id"].as_str().unwrap()
        );
        let title = format!("{path}/title");
        let renamed = app
            .clone()
            .oneshot(put_json(
                &path,
                serde_json::json!({ "title": "Release checklist" }),
            ))
            .await
            .unwrap();
        assert_eq!(renamed.status(), StatusCode::OK);
        let response = app.clone().oneshot(get(&title)).await.unwrap();
        assert_eq!(json_body(response).await, "Release checklist");
        let response = app.clone().oneshot(delete_request(&path)).await.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            app.oneshot(get(&title)).await.unwrap().status(),
            StatusCode::NOT_FOUND
        );
        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn library_search_reads_full_text_and_returns_the_matching_passage() {
        let (app, directory) = test_app(None).await;
        let created = app
            .clone()
            .oneshot(create_document_request())
            .await
            .unwrap();
        let id = json_body(created).await["id"].as_str().unwrap().to_owned();
        let path = format!("/api/documents/{id}");
        let content = format!(
            "<p>{}</p><p>Then we found <b>İZ</b>&nbsp;R&amp;D in the archive.</p>",
            "Opening words. ".repeat(200)
        );
        let saved = app
            .clone()
            .oneshot(put_json(
                &path,
                serde_json::json!({ "title": "Meeting notes", "content": content }),
            ))
            .await
            .unwrap();
        assert_eq!(saved.status(), StatusCode::OK);

        let search = |query: &str| {
            app.clone().oneshot(get(&format!(
                "/api/documents/search?q={}",
                encode_query_value(query)
            )))
        };
        let body = json_body(search("i\u{0307}z   r&d").await.unwrap()).await;
        let hits = body["matches"].as_array().unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["id"], id);
        assert_eq!(hits[0]["body_match"]["matched"], "İZ R&D");
        assert_eq!(hits[0]["body_match"]["after"], " in the archive.");
        assert!(!hits[0]["preview"].as_str().unwrap().contains("archive"));
        assert!(hits[0].get("title_match").is_none());

        let body = json_body(search("NOTES").await.unwrap()).await;
        assert_eq!(body["matches"][0]["title_match"]["matched"], "notes");
        assert!(body["matches"][0].get("body_match").is_none());

        let deleted = app.clone().oneshot(delete_request(&path)).await.unwrap();
        assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
        let body = json_body(search("archive").await.unwrap()).await;
        assert_eq!(body["matches"], serde_json::json!([]));

        let _ = tokio::fs::remove_dir_all(directory).await;
    }
}

#[cfg(test)]
mod google_tests {
    use super::tests::{
        create_document_request, get as get_request, json_body, post_json, test_app,
        test_app_with_drive,
    };
    use super::*;
    use axum::extract::State as AxumState;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tower::ServiceExt;

    #[derive(Clone)]
    struct MockState {
        base: String,
        uploads: Arc<AtomicUsize>,
    }

    async fn mock_token() -> Json<serde_json::Value> {
        Json(serde_json::json!({
            "access_token": "access-1",
            "refresh_token": "refresh-1",
            "expires_in": 3600,
            "token_type": "Bearer"
        }))
    }

    async fn mock_files() -> Json<serde_json::Value> {
        Json(serde_json::json!({ "files": [] }))
    }

    async fn mock_create_folder() -> Json<serde_json::Value> {
        Json(serde_json::json!({ "id": "folder-1", "name": "Grapho" }))
    }

    async fn mock_start_upload(AxumState(state): AxumState<MockState>) -> Response {
        (
            StatusCode::OK,
            [(header::LOCATION, format!("{}/upload/session/1", state.base))],
        )
            .into_response()
    }

    async fn mock_upload(AxumState(state): AxumState<MockState>) -> Json<serde_json::Value> {
        state.uploads.fetch_add(1, Ordering::SeqCst);
        Json(serde_json::json!({ "id": "file-1", "name": "document.json" }))
    }

    async fn mock_delete() -> StatusCode {
        StatusCode::NO_CONTENT
    }

    async fn callback_page(response: Response) -> String {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("a body");
        String::from_utf8(bytes.to_vec()).expect("utf-8 page")
    }

    #[tokio::test]
    async fn a_google_sign_in_completes_against_a_mock_google() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port");
        let base = format!("http://{}", listener.local_addr().expect("an address"));
        let mock_state = MockState {
            base: base.clone(),
            uploads: Arc::new(AtomicUsize::new(0)),
        };

        let mock = Router::new()
            .route("/token", post(mock_token))
            .route("/drive/v3/files", get(mock_files).post(mock_create_folder))
            .route("/upload/drive/v3/files", post(mock_start_upload))
            .route("/upload/session/1", axum::routing::put(mock_upload))
            .route("/drive/v3/files/{id}", axum::routing::delete(mock_delete))
            .with_state(mock_state.clone());
        tokio::spawn(async move {
            let _ = axum::serve(listener, mock).await;
        });

        let drive = Drive::with_endpoints(
            &format!("{base}/auth"),
            &format!("{base}/token"),
            &format!("{base}/drive/v3"),
            &format!("{base}/upload/drive/v3"),
        );
        let (app, directory) = test_app_with_drive(None, drive).await;

        let response = app
            .clone()
            .oneshot(create_document_request())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);

        let response = app
            .clone()
            .oneshot(post_json(
                "/api/storage/backups/google",
                serde_json::json!({
                    "client_id": "client-id.apps.googleusercontent.com",
                    "client_secret": "client-secret",
                    "folder": "Grapho"
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = json_body(response).await;
        let auth_url = body["auth_url"].as_str().expect("an auth url").to_owned();
        assert!(auth_url.starts_with(&format!("{base}/auth?")));
        assert!(auth_url.contains("code_challenge_method=S256"));
        assert!(auth_url.contains("access_type=offline"));

        let state = auth_url
            .split("state=")
            .nth(1)
            .expect("a state")
            .split('&')
            .next()
            .expect("a value")
            .to_owned();

        let response = app
            .clone()
            .oneshot(get_request(&format!(
                "/oauth/google/callback?state={state}&code=the-code"
            )))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let page = callback_page(response).await;
        assert!(page.contains("Google Drive connected"), "page: {page}");

        let body = json_body(
            app.clone()
                .oneshot(get_request("/api/storage"))
                .await
                .unwrap(),
        )
        .await;
        let backups = body["backups"].as_array().expect("backups");
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0]["kind"], "googledrive");
        assert_eq!(backups[0]["folder"], "Grapho");
        assert_eq!(body["backups_editable"], true);

        let saved: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(directory.join("test-settings.json"))
                .await
                .expect("settings"),
        )
        .expect("settings json");
        assert_eq!(saved["backups"][0]["kind"], "googledrive");

        let secrets: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(directory.join("test-secrets.json"))
                .await
                .expect("secrets"),
        )
        .expect("secrets json");
        let entries = secrets.as_object().expect("secret entries");
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries.values().next().unwrap()["refresh_token"],
            "refresh-1"
        );

        assert_eq!(
            mock_state.uploads.load(Ordering::SeqCst),
            2,
            "the Markdown document and index were seeded over the Drive API"
        );

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn the_google_sign_in_must_start_from_loopback() {
        let (app, directory) = test_app(None).await;

        let request = Request::builder()
            .method("POST")
            .uri("/api/storage/backups/google")
            .header(header::HOST, "example.com:25265")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({
                    "client_id": "cid",
                    "client_secret": "secret",
                    "folder": "Grapho"
                })
                .to_string(),
            ))
            .expect("valid test request");

        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(json_body(response).await["error"]
            .as_str()
            .expect("a message")
            .contains("loopback"));

        let _ = tokio::fs::remove_dir_all(directory).await;
    }

    #[tokio::test]
    async fn the_google_callback_needs_a_live_sign_in() {
        let (app, directory) = test_app(None).await;

        let response = app
            .clone()
            .oneshot(get_request(
                "/oauth/google/callback?state=unknown&code=code",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let page = callback_page(response).await;
        assert!(page.contains("expired"), "page: {page}");
        assert!(page.contains("Back to Storage"));

        let _ = tokio::fs::remove_dir_all(directory).await;
    }
}
