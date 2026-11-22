//! Google Drive.
//!
//! Grapho authenticates as a desktop OAuth client the user creates in their own
//! Google Cloud project: the app cannot ship a client id that belongs to every
//! installation. The flow is the loopback one — the browser is sent to Google
//! with a PKCE challenge, Google redirects back to this server with a code, and
//! the code is exchanged for an access token and a refresh token. Only the
//! `drive.file` scope is requested, which limits Grapho to the files it creates.
//!
//! A mirror needs very little Drive: find or create a folder, list it, upload
//! into it, and delete from it. Those calls are synchronous (`ureq`), so callers
//! run them on a blocking thread.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const API_URL: &str = "https://www.googleapis.com/drive/v3";
const UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3";
pub const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
/// A pending sign-in is good for ten minutes, long enough for a consent screen.
const PENDING_LIFETIME: Duration = Duration::from_secs(600);

#[derive(Clone, Debug)]
pub struct Credentials {
    pub client_id: String,
    pub client_secret: String,
    pub refresh_token: String,
}

#[derive(Debug, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder {
    pub id: String,
    pub name: String,
}

struct CachedToken {
    access: String,
    expires: Instant,
}

/// One Drive connection: endpoints, a token cache, and a small HTTP agent.
pub struct Drive {
    auth_url: String,
    token_url: String,
    api_url: String,
    upload_url: String,
    agent: ureq::Agent,
    tokens: Mutex<HashMap<Uuid, CachedToken>>,
}

impl Drive {
    pub fn new() -> Self {
        Self::build(AUTH_URL, TOKEN_URL, API_URL, UPLOAD_URL)
    }

    #[cfg(test)]
    pub fn with_endpoints(
        auth_url: &str,
        token_url: &str,
        api_url: &str,
        upload_url: &str,
    ) -> Self {
        Self::build(auth_url, token_url, api_url, upload_url)
    }

    fn build(auth_url: &str, token_url: &str, api_url: &str, upload_url: &str) -> Self {
        Self {
            auth_url: auth_url.to_owned(),
            token_url: token_url.to_owned(),
            api_url: api_url.to_owned(),
            upload_url: upload_url.to_owned(),
            agent: ureq::AgentBuilder::new().timeout(NETWORK_TIMEOUT).build(),
            tokens: Mutex::new(HashMap::new()),
        }
    }

    /// Where the browser should be sent to ask for access.
    pub fn authorization_url(
        &self,
        client_id: &str,
        redirect_uri: &str,
        state: &str,
        challenge: &str,
    ) -> String {
        let query = form_encode(&[
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("response_type", "code"),
            ("scope", SCOPE),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("include_granted_scopes", "true"),
            ("state", state),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
        ]);

        format!("{}?{query}", self.auth_url)
    }

    /// Trade the one-time code for tokens.
    pub fn exchange(
        &self,
        client_id: &str,
        client_secret: &str,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> Result<Tokens, String> {
        let body = form_encode(&[
            ("code", code),
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("redirect_uri", redirect_uri),
            ("grant_type", "authorization_code"),
            ("code_verifier", verifier),
        ]);

        self.token_request(&body)
    }

    fn refresh(&self, credentials: &Credentials) -> Result<Tokens, String> {
        let body = form_encode(&[
            ("client_id", &credentials.client_id),
            ("client_secret", &credentials.client_secret),
            ("refresh_token", &credentials.refresh_token),
            ("grant_type", "refresh_token"),
        ]);

        self.token_request(&body)
    }

    fn token_request(&self, body: &str) -> Result<Tokens, String> {
        let reply = finish(
            self.agent
                .post(&self.token_url)
                .set("content-type", "application/x-www-form-urlencoded")
                .send_string(body),
        )?;

        serde_json::from_str(&reply.body)
            .map_err(|_| "Google's sign-in answer could not be read.".to_owned())
    }

    /// Keep the access token from the sign-in so the first seed does not need a
    /// second token request.
    pub fn cache(&self, id: Uuid, tokens: &Tokens) {
        let expires = Instant::now() + token_lifetime(tokens);
        self.tokens.lock().expect("drive token lock").insert(
            id,
            CachedToken {
                access: tokens.access_token.clone(),
                expires,
            },
        );
    }

    pub(crate) fn access_token(
        &self,
        id: Uuid,
        credentials: &Credentials,
    ) -> Result<String, String> {
        if let Some(cached) = self.tokens.lock().expect("drive token lock").get(&id) {
            if cached.expires > Instant::now() {
                return Ok(cached.access.clone());
            }
        }

        let tokens = self.refresh(credentials)?;
        let access = tokens.access_token.clone();
        let expires = Instant::now() + token_lifetime(&tokens);
        self.tokens
            .lock()
            .expect("drive token lock")
            .insert(id, CachedToken { access, expires });
        Ok(tokens.access_token)
    }

    /// The folder Grapho mirrors into: found by name, or created.
    pub fn ensure_folder(&self, token: &str, name: &str) -> Result<Folder, String> {
        let query = format!(
            "name = '{}' and mimeType = '{}' and trashed = false",
            escape_query(name),
            FOLDER_MIME
        );
        let url = format!(
            "{}/files?q={}&fields=files(id,name)&spaces=drive&pageSize=1",
            self.api_url,
            percent_encode(&query)
        );
        let reply = self.call(self.authorized_get(token, &url), None)?;
        let body: serde_json::Value = parse_json(&reply.body)?;
        if let Some(folder) = body.pointer("/files/0").and_then(folder_from) {
            return Ok(folder);
        }

        let metadata = serde_json::json!({ "name": name, "mimeType": FOLDER_MIME }).to_string();
        let url = format!("{}/files?fields=id,name", self.api_url);
        let reply = self.call(
            self.agent
                .post(&url)
                .set("authorization", &bearer(token))
                .set("content-type", "application/json; charset=UTF-8"),
            Some(metadata.as_bytes()),
        )?;

        let body: serde_json::Value = parse_json(&reply.body)?;
        folder_from(&body).ok_or_else(|| "Google did not return the new folder.".to_owned())
    }

    /// Every file in a folder, following pagination.
    pub fn list_folder(&self, token: &str, folder_id: &str) -> Result<Vec<Folder>, String> {
        let query = format!(
            "'{}' in parents and trashed = false",
            escape_query(folder_id)
        );
        let mut files = Vec::new();
        let mut page: Option<String> = None;

        loop {
            let mut url = format!(
                "{}/files?q={}&fields=nextPageToken,files(id,name)&pageSize=1000&spaces=drive",
                self.api_url,
                percent_encode(&query)
            );
            if let Some(page_token) = &page {
                url.push_str("&pageToken=");
                url.push_str(&percent_encode(page_token));
            }

            let reply = self.call(self.authorized_get(token, &url), None)?;
            let body: serde_json::Value = parse_json(&reply.body)?;

            if let Some(items) = body.get("files").and_then(|value| value.as_array()) {
                for item in items {
                    if let Some(folder) = folder_from(item) {
                        files.push(folder);
                    }
                }
            }

            match body.get("nextPageToken").and_then(|value| value.as_str()) {
                Some(next) if !next.is_empty() => page = Some(next.to_owned()),
                _ => break,
            }
        }

        Ok(files)
    }

    /// Upload one file, creating it or replacing the content of `file_id`.
    /// The upload is resumable so an image is not held to the
    /// small-file limit; the whole body still goes in one request.
    pub fn upload(
        &self,
        token: &str,
        file_id: Option<&str>,
        name: &str,
        folder_id: &str,
        bytes: &[u8],
    ) -> Result<String, String> {
        let content_type = match name.rsplit_once('.').map(|(_, extension)| extension) {
            Some("json") => "application/json",
            Some("md") => "text/markdown; charset=UTF-8",
            _ => {
                crate::markdown::attachment_content_type(name).unwrap_or("application/octet-stream")
            }
        };
        let metadata = match file_id {
            Some(_) => "{}".to_owned(),
            None => serde_json::json!({ "name": name, "parents": [folder_id] }).to_string(),
        };

        let request = match file_id {
            Some(id) => self.agent.patch(&format!(
                "{}/files/{}?uploadType=resumable&fields=id,name",
                self.upload_url, id
            )),
            None => self.agent.post(&format!(
                "{}/files?uploadType=resumable&fields=id,name",
                self.upload_url
            )),
        };

        let reply = self.call(
            request
                .set("authorization", &bearer(token))
                .set("content-type", "application/json; charset=UTF-8")
                .set("x-upload-content-type", content_type)
                .set("x-upload-content-length", &bytes.len().to_string()),
            Some(metadata.as_bytes()),
        )?;

        let location = reply
            .location
            .ok_or_else(|| "Google did not open an upload session.".to_owned())?;

        let reply = self.call(
            self.agent.put(&location).set("content-type", content_type),
            Some(bytes),
        )?;

        let body: serde_json::Value = parse_json(&reply.body)?;
        body.get("id")
            .and_then(|value| value.as_str())
            .map(str::to_owned)
            .ok_or_else(|| "Google did not return the uploaded file id.".to_owned())
    }

    pub fn download_text(&self, token: &str, file_id: &str) -> Result<String, String> {
        let url = format!(
            "{}/files/{}?alt=media",
            self.api_url,
            percent_encode(file_id)
        );
        Ok(self.call(self.authorized_get(token, &url), None)?.body)
    }

    pub fn delete(&self, token: &str, file_id: &str) -> Result<(), String> {
        let url = format!("{}/files/{}", self.api_url, file_id);
        self.call(
            self.agent.delete(&url).set("authorization", &bearer(token)),
            None,
        )?;
        Ok(())
    }

    fn authorized_get(&self, token: &str, url: &str) -> ureq::Request {
        self.agent.get(url).set("authorization", &bearer(token))
    }

    fn call(&self, request: ureq::Request, body: Option<&[u8]>) -> Result<Reply, String> {
        let result = match body {
            Some(bytes) => request.send_bytes(bytes),
            None => request.call(),
        };
        finish(result)
    }
}

impl Default for Drive {
    fn default() -> Self {
        Self::new()
    }
}

struct Reply {
    body: String,
    location: Option<String>,
}

fn finish(result: Result<ureq::Response, ureq::Error>) -> Result<Reply, String> {
    match result {
        Ok(response) => Ok(Reply {
            location: response.header("location").map(str::to_owned),
            body: response.into_string().unwrap_or_default(),
        }),
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            Err(message_for(code, &body))
        }
        Err(ureq::Error::Transport(error)) => {
            Err(format!("Grapho could not reach Google: {error}"))
        }
    }
}

fn message_for(code: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(message) = value.pointer("/error/message").and_then(|v| v.as_str()) {
            return format!("Google said: {message}");
        }
    }
    format!("Google answered with HTTP {code}.")
}

fn parse_json(body: &str) -> Result<serde_json::Value, String> {
    serde_json::from_str(body).map_err(|_| "Google's answer could not be read.".to_owned())
}

fn folder_from(value: &serde_json::Value) -> Option<Folder> {
    let id = value.get("id")?.as_str()?;
    let name = value.get("name")?.as_str()?;
    Some(Folder {
        id: id.to_owned(),
        name: name.to_owned(),
    })
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

fn token_lifetime(tokens: &Tokens) -> Duration {
    let seconds = tokens.expires_in.unwrap_or(3600);
    Duration::from_secs(seconds.saturating_sub(60).max(30))
}

/// A pending sign-in: what the callback needs, held only until it arrives.
pub struct Pending {
    pub client_id: String,
    pub client_secret: String,
    pub folder: String,
    pub redirect_uri: String,
    pub verifier: String,
    created: Instant,
}

impl Pending {
    pub fn new(
        client_id: String,
        client_secret: String,
        folder: String,
        redirect_uri: String,
        verifier: String,
    ) -> Self {
        Self {
            client_id,
            client_secret,
            folder,
            redirect_uri,
            verifier,
            created: Instant::now(),
        }
    }
}

/// The sign-ins waiting for Google to redirect back, keyed by their one-time
/// state value.
pub struct OAuthStore {
    pending: Mutex<HashMap<String, Pending>>,
}

impl OAuthStore {
    pub fn new() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }

    pub fn begin(&self, pending: Pending) -> Result<String, String> {
        let state = random_token(24)?;
        let mut pending_map = self.pending.lock().expect("oauth store lock");
        pending_map.retain(|_, entry| entry.created.elapsed() < PENDING_LIFETIME);
        pending_map.insert(state.clone(), pending);
        Ok(state)
    }

    /// Take a pending sign-in. A state value works once.
    pub fn take(&self, state: &str) -> Option<Pending> {
        let pending = self
            .pending
            .lock()
            .expect("oauth store lock")
            .remove(state)?;
        (pending.created.elapsed() < PENDING_LIFETIME).then_some(pending)
    }
}

impl Default for OAuthStore {
    fn default() -> Self {
        Self::new()
    }
}

/// A random PKCE verifier.
pub fn new_verifier() -> Result<String, String> {
    Ok(base64_url(&random_bytes(32)?))
}

/// The S256 challenge for a verifier.
pub fn challenge(verifier: &str) -> String {
    base64_url(&Sha256::digest(verifier.as_bytes()))
}

fn random_bytes(count: usize) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; count];
    getrandom::fill(&mut bytes).map_err(|error| format!("could not generate a secret: {error}"))?;
    Ok(bytes)
}

fn random_token(bytes: usize) -> Result<String, String> {
    Ok(random_bytes(bytes)?
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn base64_url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0] as u32;
        let second = *chunk.get(1).unwrap_or(&0) as u32;
        let third = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (first << 16) | (second << 8) | third;

        out.push(TABLE[((triple >> 18) & 63) as usize] as char);
        out.push(TABLE[((triple >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 63) as usize] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 63) as usize] as char);
        }
    }
    out
}

fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn form_encode(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Drive query strings are single-quoted; a quote in a name needs a backslash.
fn escape_query(value: &str) -> String {
    value.replace('\\', "\\\\").replace('\'', "\\'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_matches_the_rfc_example() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn base64_url_has_no_padding_or_plus() {
        assert_eq!(base64_url(b""), "");
        assert_eq!(base64_url(b"f"), "Zg");
        assert_eq!(base64_url(b"fo"), "Zm8");
        assert_eq!(base64_url(b"foo"), "Zm9v");
        assert_eq!(base64_url(b"foobar"), "Zm9vYmFy");
        assert!(!base64_url(&[0xfb, 0xff]).contains(['+', '/', '=']));
    }

    #[test]
    fn form_values_are_encoded() {
        assert_eq!(
            form_encode(&[("redirect_uri", "http://127.0.0.1:25265/oauth")]),
            "redirect_uri=http%3A%2F%2F127.0.0.1%3A25265%2Foauth"
        );
        assert_eq!(percent_encode("a b'c"), "a%20b%27c");
        assert_eq!(escape_query("a'b"), "a\\'b");
    }

    #[test]
    fn the_authorization_url_asks_for_offline_access_and_pkce() {
        let drive = Drive::new();
        let url = drive.authorization_url(
            "client-id.apps.googleusercontent.com",
            "http://127.0.0.1:25265/oauth/google/callback",
            "state-value",
            "challenge-value",
        );

        assert!(url.starts_with("https://accounts.google.com/o/oauth2/v2/auth?"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("access_type=offline"));
        assert!(url.contains("prompt=consent"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains(&percent_encode(SCOPE)));
        assert!(url.contains("client_id=client-id.apps.googleusercontent.com"));
        assert!(url.contains("state=state-value"));
        assert!(url.contains("code_challenge=challenge-value"));
    }

    #[test]
    fn google_errors_become_readable_messages() {
        let body =
            r#"{"error":{"code":401,"message":"Invalid Credentials","status":"UNAUTHENTICATED"}}"#;
        assert_eq!(message_for(401, body), "Google said: Invalid Credentials");
        assert_eq!(message_for(500, ""), "Google answered with HTTP 500.");
    }

    #[test]
    fn listings_and_folders_parse() {
        let value: serde_json::Value = serde_json::from_str(
            r#"{"files":[{"id":"a1","name":"one.json"},{"id":"b2","name":"two.json"}],"nextPageToken":"p"}"#,
        )
        .unwrap();
        let files: Vec<Folder> = value["files"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(folder_from)
            .collect();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].id, "a1");
        assert_eq!(files[1].name, "two.json");
    }

    #[test]
    fn a_pending_sign_in_is_single_use_and_expires() {
        let store = OAuthStore::new();
        let pending = Pending::new(
            "client".to_owned(),
            "secret".to_owned(),
            "Grapho".to_owned(),
            "http://127.0.0.1/oauth".to_owned(),
            "verifier".to_owned(),
        );
        let state = store.begin(pending).expect("a state is made");

        assert_eq!(
            store
                .begin(Pending::new(
                    "a".into(),
                    "b".into(),
                    "Grapho".into(),
                    "u".into(),
                    "v".into()
                ))
                .unwrap()
                .len(),
            48
        );
        assert!(store.take(&state).is_some());
        assert!(store.take(&state).is_none(), "a state works once");
        assert!(store.take("unknown").is_none());
    }
}
