use std::fmt;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::assets;
use crate::store::{Document, DocumentSummary, SharedStore, StoreError};

const BODY_LIMIT_BYTES: usize = 8 * 1024 * 1024;
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

#[derive(Clone)]
pub struct AppState {
    pub store: SharedStore,
}

pub fn router(store: SharedStore) -> Router {
    Router::new()
        .route("/", get(home_page))
        .route("/doc/{id}", get(editor_page))
        .route("/api/documents", get(list_documents).post(create_document))
        .route(
            "/api/documents/{id}",
            get(get_document)
                .put(update_document)
                .delete(delete_document),
        )
        .route("/api/health", get(health))
        .route("/assets/{*path}", get(asset))
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(BODY_LIMIT_BYTES))
        .layer(middleware::from_fn(security_headers))
        .with_state(AppState { store })
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

async fn editor_page(State(state): State<AppState>, Path(raw_id): Path<String>) -> Response {
    let Some(id) = parse_document_id(&raw_id) else {
        return page_not_found();
    };

    if state.store.get(id).await.is_none() {
        return page_not_found();
    }

    with_page_cache(
        (
            [(header::CACHE_CONTROL, "no-cache")],
            Html(assets::EDITOR_HTML),
        )
            .into_response(),
    )
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

#[derive(Serialize)]
struct DocumentList {
    documents: Vec<DocumentSummary>,
}

async fn list_documents(State(state): State<AppState>) -> Json<DocumentList> {
    Json(DocumentList {
        documents: state.store.list().await,
    })
}

#[derive(Serialize)]
struct DocumentView {
    id: Uuid,
    title: String,
    content: String,
    created_at: u64,
    updated_at: u64,
}

impl From<Document> for DocumentView {
    fn from(document: Document) -> Self {
        Self {
            id: document.id,
            title: document.title,
            content: document.content,
            created_at: document.created_at,
            updated_at: document.updated_at,
        }
    }
}

async fn create_document(State(state): State<AppState>) -> Result<impl IntoResponse, ApiError> {
    let document = state.store.create().await?;
    Ok((StatusCode::CREATED, Json(DocumentView::from(document))))
}

async fn get_document(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
) -> Result<Json<DocumentView>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    let document = state.store.get(id).await.ok_or_else(ApiError::not_found)?;
    Ok(Json(DocumentView::from(document)))
}

#[derive(Deserialize, Default)]
struct UpdateDocumentRequest {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

async fn update_document(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
    Json(patch): Json<UpdateDocumentRequest>,
) -> Result<Json<DocumentView>, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    let document = state
        .store
        .update(id, patch.title, patch.content)
        .await?
        .ok_or_else(ApiError::not_found)?;
    Ok(Json(DocumentView::from(document)))
}

async fn delete_document(
    State(state): State<AppState>,
    Path(raw_id): Path<String>,
) -> Result<StatusCode, ApiError> {
    let id = parse_document_id(&raw_id).ok_or_else(ApiError::not_found)?;
    if state.store.delete(id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found())
    }
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
        HeaderValue::from_static(CSP),
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
    use axum::body::Body;

    fn mutation_with_origin(origin: Option<&str>) -> Request {
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/documents")
            .header(header::HOST, "127.0.0.1:3000");
        if let Some(origin) = origin {
            builder = builder.header(header::ORIGIN, origin);
        }
        builder.body(Body::empty()).expect("valid test request")
    }

    #[test]
    fn same_origin_mutations_are_allowed() {
        assert!(is_same_origin(&mutation_with_origin(None)));
        assert!(is_same_origin(&mutation_with_origin(Some(
            "http://127.0.0.1:3000"
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
}
