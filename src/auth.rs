//! The optional password gate.
//!
//! Grapho has no accounts. When `GRAPHO_PASSWORD_HASH` holds an Argon2id hash,
//! one password guards every document: a correct password mints a random session
//! token that lives only in this process's memory and travels in an HttpOnly
//! cookie. Restarting Grapho forgets every session, and a new hash takes effect on
//! the next start.

use std::collections::HashMap;
use std::env;
use std::fmt::Write as _;
use std::fs;
use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::time::{Duration, Instant};

use argon2::password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier};
use argon2::{Argon2, Params};
use axum::http::{header, HeaderMap};
use tokio::sync::Semaphore;

/// Name of the session cookie.
pub const SESSION_COOKIE: &str = "grapho_session";

/// How long a session lives after its last use.
const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// A browser that keeps working keeps one cookie. A handful of extra sessions
/// covers several devices; anything beyond that is noise.
const MAX_SESSIONS: usize = 32;

/// Passwords longer than this are refused instead of hashed. Argon2's cost does
/// not grow with the input, but buffering megabytes of body for a login attempt
/// is pointless.
pub const MAX_PASSWORD_BYTES: usize = 1024;

/// The window in which repeated failures are counted.
const LOGIN_WINDOW: Duration = Duration::from_secs(15 * 60);

/// Failed logins allowed per window before logins pause. Argon2 already makes
/// guessing expensive; this keeps a determined client from tying up the process.
const MAX_FAILED_LOGINS: u32 = 10;

const TOKEN_BYTES: usize = 32;
const MIN_PASSWORD_CHARS: usize = 12;
const MAX_HASH_BYTES: usize = 512;

/// Argon2 parameters are read from the configured hash, so a typo in the memory
/// cost should not turn the first login into an out-of-memory crash.
const MAX_MEMORY_KIB: u32 = 1024 * 1024;
const MAX_TIME_COST: u32 = 64;

/// The optional password gate shared by the HTTP layer.
pub struct Auth {
    hash: String,
    sessions: RwLock<HashMap<String, Instant>>,
    throttle: Mutex<Throttle>,
    /// Argon2 is deliberately slow and memory hungry. One check at a time keeps a
    /// burst of login attempts from multiplying that cost.
    verify_slot: Arc<Semaphore>,
}

impl Auth {
    /// Build the gate from an Argon2id hash in PHC form.
    pub fn new(hash: impl Into<String>) -> Result<Self, String> {
        let hash = hash.into();
        let hash = hash.trim().to_owned();
        validate_hash(&hash)?;

        Ok(Self {
            hash,
            sessions: RwLock::new(HashMap::new()),
            throttle: Mutex::new(Throttle::default()),
            verify_slot: Arc::new(Semaphore::new(1)),
        })
    }

    /// Read the password configuration from the environment.
    ///
    /// `GRAPHO_PASSWORD_HASH_FILE` takes precedence over `GRAPHO_PASSWORD_HASH`,
    /// which is how a container receives its secret as a mounted file. A plain
    /// `GRAPHO_PASSWORD` is refused rather than ignored, so a deployment can never
    /// believe it is protected when it is not.
    pub fn from_environment() -> Result<Option<Self>, String> {
        if env::var_os("GRAPHO_PASSWORD").is_some() {
            return Err(concat!(
                "GRAPHO_PASSWORD is not supported. Set GRAPHO_PASSWORD_HASH to the hash\n",
                "  printed by `grapho hash-password` instead."
            )
            .to_owned());
        }

        let hash_file = env::var_os("GRAPHO_PASSWORD_HASH_FILE").map(PathBuf::from);
        let hash = match hash_file {
            Some(path) => Some(read_hash_file(&path)?),
            None => env::var("GRAPHO_PASSWORD_HASH").ok(),
        };

        match hash {
            Some(hash) => Self::new(hash).map(Some),
            None => Ok(None),
        }
    }

    /// Verify a password without blocking the async runtime.
    ///
    /// The blocking task owns the single verification permit until it finishes,
    /// so concurrent login attempts queue instead of each allocating Argon2's
    /// memory.
    pub async fn check_password(self: &Arc<Self>, password: String) -> Result<bool, String> {
        let slot = Arc::clone(&self.verify_slot);
        let permit = slot
            .acquire_owned()
            .await
            .map_err(|error| format!("the password check could not start: {error}"))?;
        let auth = Arc::clone(self);

        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            auth.password_matches(&password)
        })
        .await
        .map_err(|error| format!("the password check could not finish: {error}"))
    }

    fn password_matches(&self, password: &str) -> bool {
        let Ok(parsed) = PasswordHash::new(&self.hash) else {
            return false;
        };
        Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok()
    }

    /// Mint a session token. The caller sends it back in a cookie.
    pub fn begin_session(&self) -> Result<String, String> {
        let token = random_token()?;
        let now = Instant::now();
        let mut sessions = write_lock(&self.sessions);

        // Drop expired sessions and, in the unlikely case of a full table, the one
        // closest to expiring.
        sessions.retain(|_, expires| *expires > now);
        if sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, expires)| **expires)
                .map(|(token, _)| token.clone())
            {
                sessions.remove(&oldest);
            }
        }

        sessions.insert(token.clone(), now + SESSION_TTL);
        Ok(token)
    }

    /// Whether a token belongs to a live session. A session in its last half-life
    /// is extended, so an actively used browser is not signed out mid-sentence.
    pub fn session_is_valid(&self, token: &str) -> bool {
        self.session_is_valid_at(token, Instant::now())
    }

    fn session_is_valid_at(&self, token: &str, now: Instant) -> bool {
        {
            let sessions = read_lock(&self.sessions);
            match sessions.get(token) {
                Some(expires) if *expires > now => {
                    if *expires - now >= SESSION_TTL / 2 {
                        return true;
                    }
                }
                Some(_) => return false,
                None => return false,
            }
        }

        let mut sessions = write_lock(&self.sessions);
        match sessions.get(token) {
            Some(expires) if *expires > now => {
                sessions.insert(token.to_owned(), now + SESSION_TTL);
                true
            }
            _ => false,
        }
    }

    pub fn end_session(&self, token: &str) {
        write_lock(&self.sessions).remove(token);
    }

    /// How long the client should wait before trying another password, when too
    /// many attempts have failed recently.
    pub fn retry_after(&self) -> Option<Duration> {
        mutex_lock(&self.throttle).retry_after(Instant::now())
    }

    pub fn record_failure(&self) {
        mutex_lock(&self.throttle).record_failure(Instant::now());
    }

    pub fn record_success(&self) {
        mutex_lock(&self.throttle).clear();
    }
}

/// Failed logins are counted globally, not per address: behind a reverse proxy
/// every request arrives from the same address, and Grapho has only one password
/// to protect.
struct Throttle {
    failures: u32,
    window_start: Instant,
    blocked_until: Option<Instant>,
}

impl Default for Throttle {
    fn default() -> Self {
        Self {
            failures: 0,
            window_start: Instant::now(),
            blocked_until: None,
        }
    }
}

impl Throttle {
    fn retry_after(&self, now: Instant) -> Option<Duration> {
        self.blocked_until
            .filter(|blocked| now < *blocked)
            .map(|blocked| blocked - now)
    }

    fn record_failure(&mut self, now: Instant) {
        if now.saturating_duration_since(self.window_start) >= LOGIN_WINDOW {
            self.clear_at(now);
        }

        self.failures = self.failures.saturating_add(1);
        if self.failures >= MAX_FAILED_LOGINS {
            self.blocked_until = Some(self.window_start + LOGIN_WINDOW);
        }
    }

    fn clear(&mut self) {
        self.clear_at(Instant::now());
    }

    fn clear_at(&mut self, now: Instant) {
        self.failures = 0;
        self.window_start = now;
        self.blocked_until = None;
    }
}

/// The session token from the request's cookies, if it looks like one of ours.
pub fn session_token(headers: &HeaderMap) -> Option<String> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(text) = value.to_str() else {
            continue;
        };
        for pair in text.split(';') {
            let Some((name, value)) = pair.split_once('=') else {
                continue;
            };
            let value = value.trim();
            if name.trim() == SESSION_COOKIE && is_session_token(value) {
                return Some(value.to_owned());
            }
        }
    }
    None
}

fn is_session_token(value: &str) -> bool {
    value.len() == TOKEN_BYTES * 2 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// A cookie that stores the session token and nothing else. `SameSite=Strict`
/// keeps other sites from making authenticated requests even if a future change
/// forgets the same-origin check in `api.rs`.
pub fn session_cookie(token: &str, secure: bool) -> String {
    let mut cookie = format!(
        "{SESSION_COOKIE}={token}; Path=/; Max-Age={}; HttpOnly; SameSite=Strict",
        SESSION_TTL.as_secs()
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

pub fn cleared_session_cookie(secure: bool) -> String {
    let mut cookie = format!("{SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict");
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

/// Grapho has no TLS of its own, so a reverse proxy is the only thing that can
/// tell it the request arrived over HTTPS.
pub fn request_is_secure(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("https"))
}

fn validate_hash(hash: &str) -> Result<(), String> {
    if hash.is_empty() {
        return Err(
            "GRAPHO_PASSWORD_HASH is empty. Run `grapho hash-password` to make one.".into(),
        );
    }
    if hash.len() > MAX_HASH_BYTES {
        return Err("GRAPHO_PASSWORD_HASH is too long to be a password hash.".into());
    }

    let parsed = PasswordHash::new(hash).map_err(|_| {
        concat!(
            "GRAPHO_PASSWORD_HASH is not a valid password hash.\n",
            "  Run `grapho hash-password` to make one."
        )
        .to_owned()
    })?;

    if parsed.algorithm.as_str() != "argon2id" {
        return Err(concat!(
            "GRAPHO_PASSWORD_HASH must be an Argon2id hash (it starts with $argon2id$).\n",
            "  Run `grapho hash-password` to make one."
        )
        .to_owned());
    }

    if parsed.salt.is_none() || parsed.hash.is_none() {
        return Err(
            "GRAPHO_PASSWORD_HASH is incomplete. Run `grapho hash-password` to make one.".into(),
        );
    }

    let params = Params::try_from(&parsed)
        .map_err(|error| format!("GRAPHO_PASSWORD_HASH has unusable Argon2 parameters: {error}"))?;
    if params.m_cost() > MAX_MEMORY_KIB || params.t_cost() > MAX_TIME_COST {
        return Err(format!(
            "GRAPHO_PASSWORD_HASH asks for more hashing work than Grapho will do \
             (m_cost up to {MAX_MEMORY_KIB} KiB, t_cost up to {MAX_TIME_COST})."
        ));
    }

    Ok(())
}

fn read_hash_file(path: &Path) -> Result<String, String> {
    let contents = fs::read_to_string(path).map_err(|error| {
        format!(
            "could not read GRAPHO_PASSWORD_HASH_FILE {}: {error}",
            path.display()
        )
    })?;
    let hash = contents.trim();
    if hash.is_empty() {
        return Err(format!(
            "GRAPHO_PASSWORD_HASH_FILE {} is empty",
            path.display()
        ));
    }
    Ok(hash.to_owned())
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("could not generate a session token: {error}"))?;

    let mut token = String::with_capacity(TOKEN_BYTES * 2);
    for byte in bytes {
        let _ = write!(token, "{byte:02x}");
    }
    Ok(token)
}

/// Hash a password for `GRAPHO_PASSWORD_HASH`. Used by `grapho hash-password`.
pub fn print_password_hash() -> Result<(), String> {
    let password = read_new_password()?;
    let hash = Argon2::default()
        .hash_password(password.as_bytes())
        .map_err(|error| format!("could not hash the password: {error}"))?;

    println!("{hash}");
    eprintln!();
    eprintln!("  Put this hash in GRAPHO_PASSWORD_HASH, or save it to a file and set");
    eprintln!("  GRAPHO_PASSWORD_HASH_FILE. The password itself is never stored.");
    eprintln!();
    Ok(())
}

fn read_new_password() -> Result<String, String> {
    if io::stdin().is_terminal() {
        let password = rpassword::prompt_password("Password: ")
            .map_err(|error| format!("could not read the password: {error}"))?;
        let repeated = rpassword::prompt_password("Repeat password: ")
            .map_err(|error| format!("could not read the password: {error}"))?;
        if password != repeated {
            return Err("the passwords did not match".into());
        }
        validate_new_password(&password)?;
        Ok(password)
    } else {
        // Piped input, for a password manager or a script.
        let mut line = String::new();
        io::stdin()
            .read_line(&mut line)
            .map_err(|error| format!("could not read the password: {error}"))?;
        let password = line.trim_end_matches(['\r', '\n']).to_owned();
        validate_new_password(&password)?;
        Ok(password)
    }
}

fn validate_new_password(password: &str) -> Result<(), String> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(format!(
            "use at least {MIN_PASSWORD_CHARS} characters: this one password guards every document"
        ));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(format!("use at most {MAX_PASSWORD_BYTES} bytes"));
    }
    Ok(())
}

/// A poisoned lock only means another request panicked while holding it; the
/// session table and the failure counter are still usable.
fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poison| poison.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poison| poison.into_inner())
}

fn mutex_lock<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(|poison| poison.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hash_for(password: &str) -> String {
        Argon2::default()
            .hash_password(password.as_bytes())
            .expect("test password hashes")
            .to_string()
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut headers = HeaderMap::new();
        for (name, value) in pairs {
            headers.append(
                axum::http::HeaderName::from_bytes(name.as_bytes()).expect("header name"),
                axum::http::HeaderValue::from_str(value).expect("header value"),
            );
        }
        headers
    }

    #[test]
    fn passwords_round_trip_through_argon2id() {
        let auth = Auth::new(hash_for("correct horse battery")).expect("valid hash");
        assert!(auth.password_matches("correct horse battery"));
        assert!(!auth.password_matches("correct horse batterY"));
        assert!(!auth.password_matches(""));
    }

    #[test]
    fn a_malformed_hash_is_refused_at_startup() {
        assert!(validate_hash("").unwrap_err().contains("empty"));
        assert!(validate_hash("hunter2")
            .unwrap_err()
            .contains("not a valid password hash"));

        let hash = hash_for("a password long enough");
        assert!(validate_hash(&hash).is_ok());

        let truncated = &hash[..hash.len() - 4];
        assert!(validate_hash(truncated).is_err());

        // A correct-looking hash of the wrong algorithm is refused by name.
        let argon2i = hash.replacen("$argon2id$", "$argon2i$", 1);
        assert!(validate_hash(&argon2i).unwrap_err().contains("Argon2id"));

        // So is a hash that asks for more work than the server will do.
        let expensive = hash.replace("m=19456,t=2,p=1", "m=1048576,t=65,p=1");
        assert!(validate_hash(&expensive)
            .unwrap_err()
            .contains("more hashing work"));
    }

    #[test]
    fn sessions_are_random_and_end_when_closed() {
        let auth = Auth::new(hash_for("a long enough password")).expect("valid hash");
        let first = auth.begin_session().expect("session");
        let second = auth.begin_session().expect("session");

        assert_ne!(first, second);
        assert_eq!(first.len(), TOKEN_BYTES * 2);
        assert!(auth.session_is_valid(&first));
        assert!(auth.session_is_valid(&second));

        auth.end_session(&first);
        assert!(!auth.session_is_valid(&first));
        assert!(auth.session_is_valid(&second));
        assert!(!auth.session_is_valid("0".repeat(TOKEN_BYTES * 2).as_str()));
    }

    #[test]
    fn expired_sessions_are_not_valid() {
        let auth = Auth::new(hash_for("a long enough password")).expect("valid hash");
        let token = auth.begin_session().expect("session");
        let later = Instant::now() + SESSION_TTL + Duration::from_secs(1);

        assert!(!auth.session_is_valid_at(&token, later));
        assert!(auth.session_is_valid(&token));
    }

    #[test]
    fn a_used_session_is_extended() {
        let auth = Auth::new(hash_for("a long enough password")).expect("valid hash");
        let token = auth.begin_session().expect("session");
        let almost_expired = Instant::now() + SESSION_TTL - Duration::from_secs(60);

        assert!(auth.session_is_valid_at(&token, almost_expired));
        // The extension is measured from the moment of use, not from creation.
        let extended = almost_expired + SESSION_TTL - Duration::from_secs(60);
        assert!(auth.session_is_valid_at(&token, extended));
    }

    #[test]
    fn old_sessions_are_dropped_instead_of_accumulating() {
        let auth = Auth::new(hash_for("a long enough password")).expect("valid hash");
        let mut tokens = Vec::new();
        for _ in 0..MAX_SESSIONS + 4 {
            tokens.push(auth.begin_session().expect("session"));
        }

        let live = read_lock(&auth.sessions).len();
        assert!(live <= MAX_SESSIONS, "{live} sessions kept");
        assert!(auth.session_is_valid(tokens.last().expect("a token")));
    }

    #[test]
    fn repeated_failures_pause_logins() {
        let mut throttle = Throttle::default();
        let start = throttle.window_start;

        for attempt in 0..MAX_FAILED_LOGINS {
            assert_eq!(throttle.retry_after(start), None, "attempt {attempt}");
            throttle.record_failure(start + Duration::from_secs(1));
        }

        let pause = throttle
            .retry_after(start + Duration::from_secs(2))
            .expect("logins pause");
        assert!(pause > Duration::from_secs(0));
        assert!(pause <= LOGIN_WINDOW);

        // The pause ends with the window, and a fresh window starts over.
        let after_window = start + LOGIN_WINDOW + Duration::from_secs(1);
        assert_eq!(throttle.retry_after(after_window), None);
        throttle.record_failure(after_window);
        assert_eq!(throttle.retry_after(after_window), None);
    }

    #[test]
    fn a_good_password_clears_the_failure_count() {
        let mut throttle = Throttle::default();
        let now = throttle.window_start;

        for _ in 0..MAX_FAILED_LOGINS - 1 {
            throttle.record_failure(now);
        }
        throttle.clear();
        throttle.record_failure(now);

        assert_eq!(throttle.retry_after(now), None);
    }

    #[test]
    fn the_session_cookie_is_locked_down() {
        let token = "a".repeat(TOKEN_BYTES * 2);
        let cookie = session_cookie(&token, false);
        assert!(cookie.starts_with(&format!("{SESSION_COOKIE}={token};")));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains("Path=/"));
        assert!(cookie.contains("Max-Age=2592000"));
        assert!(!cookie.contains("Secure"));

        assert!(session_cookie(&token, true).contains("; Secure"));

        let cleared = cleared_session_cookie(true);
        assert!(cleared.contains("Max-Age=0"));
        assert!(cleared.contains("Secure"));
    }

    #[test]
    fn only_a_well_formed_session_cookie_is_read() {
        let token = "0123456789abcdef".repeat(4);
        assert_eq!(
            session_token(&headers(&[(
                "cookie",
                &format!("theme=dark; {SESSION_COOKIE}={token}")
            )])),
            Some(token.clone())
        );
        assert_eq!(
            session_token(&headers(&[("cookie", "theme=dark; grapho_session=short")])),
            None
        );
        assert_eq!(session_token(&headers(&[("cookie", "")])), None);
        assert_eq!(session_token(&HeaderMap::new()), None);
    }

    #[test]
    fn the_proxy_header_decides_whether_the_cookie_is_secure() {
        assert!(request_is_secure(&headers(&[(
            "x-forwarded-proto",
            "https"
        )])));
        assert!(request_is_secure(&headers(&[(
            "x-forwarded-proto",
            "HTTPS, http"
        )])));
        assert!(!request_is_secure(&headers(&[(
            "x-forwarded-proto",
            "http"
        )])));
        assert!(!request_is_secure(&HeaderMap::new()));
    }

    #[test]
    fn generated_hashes_are_accepted_by_the_gate() {
        // The same code path the subcommand uses, without a terminal.
        let hash = hash_for("a password long enough");
        assert!(hash.starts_with("$argon2id$"));
        assert!(Auth::new(hash.clone()).is_ok());
        assert!(Auth::new(hash[..hash.len() - 4].to_owned()).is_err());
    }
}
