use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::assets;
use crate::auth::{self, Auth};
use crate::store::{Document, DocumentSummary, SharedStore, StoreError};

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

#[derive(Clone)]
pub struct AppState {
    pub store: SharedStore,
    pub auth: Option<Arc<Auth>>,
}

pub fn router(store: SharedStore, auth: Option<Arc<Auth>>) -> Router {
    let state = AppState { store, auth };

    // Everything that can read or change a document belongs on this router. A
    // route added anywhere else is public, which is why the public list below is
    // deliberately short.
    let protected = Router::new()
        .route("/", get(home_page))
        .route("/doc/{id}", get(editor_page))
        .route("/api/documents", get(list_documents).post(create_document))
        .route(
            "/api/documents/{id}",
            get(get_document)
                .put(update_document)
                .delete(delete_document),
        )
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
    /// Whether this server asks for a password, so the UI knows to offer sign out.
    auth_required: bool,
}

async fn list_documents(State(state): State<AppState>) -> Json<DocumentList> {
    Json(DocumentList {
        documents: state.store.list().await,
        auth_required: state.auth.is_some(),
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

#[derive(Deserialize)]
struct LoginRequest {
    #[serde(default)]
    password: String,
}

/// Exchange the password for a session cookie.
async fn open_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> Response {
    let Some(auth) = state.auth.clone() else {
        return ApiError::bad_request("Grapho has no password set.").into_response();
    };

    if let Some(retry_after) = auth.retry_after() {
        return too_many_attempts(retry_after);
    }

    // An empty or oversized password cannot be right, and hashing it would only
    // waste the one verification slot.
    if payload.password.is_empty() || payload.password.len() > auth::MAX_PASSWORD_BYTES {
        auth.record_failure();
        return ApiError::unauthorized("That password is not correct.").into_response();
    }

    match auth.check_password(payload.password).await {
        Ok(true) => {}
        Ok(false) => {
            auth.record_failure();
            return ApiError::unauthorized("That password is not correct.").into_response();
        }
        Err(error) => {
            eprintln!("login error: {error}");
            return ApiError::server_error("Grapho couldn't check that password.").into_response();
        }
    }

    auth.record_success();

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
    use argon2::Argon2;
    use std::path::PathBuf;
    use tower::ServiceExt;

    use crate::store::Store;

    fn test_hash(password: &str) -> String {
        Argon2::default()
            .hash_password(password.as_bytes())
            .expect("test password hashes")
            .to_string()
    }

    async fn test_app(password: Option<&str>) -> (Router, PathBuf) {
        let directory = std::env::temp_dir().join(format!("grapho-api-test-{}", Uuid::new_v4()));
        let store = Arc::new(
            Store::load(directory.clone())
                .await
                .expect("test store loads"),
        );
        let auth = password.map(|password| Arc::new(Auth::new(test_hash(password)).expect("hash")));
        (router(store, auth), directory)
    }

    fn get(uri: &str) -> Request {
        Request::builder()
            .uri(uri)
            .header(header::HOST, "127.0.0.1:25265")
            .body(Body::empty())
            .expect("valid test request")
    }

    fn login_request(password: &str) -> Request {
        Request::builder()
            .method("POST")
            .uri("/api/session")
            .header(header::HOST, "127.0.0.1:25265")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({ "password": password }).to_string(),
            ))
            .expect("valid test request")
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

    async fn json_body(response: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("response body");
        serde_json::from_slice(&bytes).expect("json body")
    }

    #[tokio::test]
    async fn private_routes_ask_for_a_password() {
        let (app, directory) = test_app(Some("a password long enough")).await;

        let response = app.clone().oneshot(get("/api/documents")).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "no-store"
        );

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

        let request = Request::builder()
            .method("POST")
            .uri("/api/session")
            .header(header::HOST, "127.0.0.1:25265")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(format!(
                "{{\"password\":\"{}\"}}",
                "a".repeat(LOGIN_BODY_LIMIT_BYTES * 2)
            )))
            .expect("valid test request");

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
}
