//! Holding requests for a look before they leave the proxy: the interface lists what is held,
//! edits it and forwards or drops it. Off by default and never saved, so a restart forwards freely.
use base64::{Engine, prelude::BASE64_STANDARD};
use http_body_util::BodyExt;
use hudsucker::{
    Body,
    hyper::{
        HeaderMap, Method, Request, Response, StatusCode, Uri,
        body::Body as _,
        header::{CONTENT_ENCODING, CONTENT_LENGTH, HeaderName, HeaderValue, TRANSFER_ENCODING},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::oneshot;

/// Holding means buffering: bodies above this pass through unheld.
pub const BODY_LIMIT: usize = 8 * 1024 * 1024;
/// A held request nobody decides on goes out unchanged after this.
pub const WAIT: Duration = Duration::from_secs(10 * 60);
pub const DROPPED: &str = "Dropped in Librium intercept";
pub const TOO_LARGE: &str = "Response too large to intercept";
pub const FAILED: &str = "Response failed while held";
const PREVIEW: usize = 64 * 1024;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Rules {
    pub enabled: bool,
    /// Host patterns like the ignore list's; empty means every host.
    pub hosts: Vec<String>,
    /// Hold responses as well as requests.
    pub responses: bool,
    /// Upper-case method names; empty means every method.
    pub methods: Vec<String>,
    /// A lower-case substring of the path; empty means every path.
    pub path: String,
}

#[derive(Clone, Serialize)]
pub struct HeldView {
    pub id: u64,
    /// "request" or "response".
    pub kind: &'static str,
    pub time: u64,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub headers: Vec<(String, String)>,
    /// A response body is shown decoded when it was compressed.
    pub text: String,
    pub base64: String,
    pub size: usize,
    pub truncated: bool,
    pub decoded: bool,
}

/// What the interface sends back for a held request. Absent fields keep the original.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Decision {
    pub action: String,
    pub method: Option<String>,
    pub url: Option<String>,
    pub status: Option<u16>,
    pub headers: Option<Vec<(String, String)>>,
    pub text: Option<String>,
    pub base64: Option<String>,
}

/// A decision with every edit parsed up front, so the proxy side cannot fail on it.
pub struct Edit {
    pub drop: bool,
    pub method: Option<Method>,
    pub uri: Option<Uri>,
    pub status: Option<StatusCode>,
    pub headers: Option<HeaderMap>,
    pub body: Option<Vec<u8>>,
}
impl Edit {
    fn forward() -> Self {
        Edit {
            drop: false,
            method: None,
            uri: None,
            status: None,
            headers: None,
            body: None,
        }
    }
}

impl Decision {
    pub fn validate(self) -> anyhow::Result<Edit> {
        let drop = match self.action.as_str() {
            "forward" => false,
            "drop" => true,
            other => anyhow::bail!("Unknown action: {other}"),
        };
        let method = self
            .method
            .map(|m| Method::from_bytes(m.trim().as_bytes()))
            .transpose()?;
        let status = self
            .status
            .map(|code| {
                StatusCode::from_u16(code)
                    .ok()
                    .filter(|s| s.as_u16() >= 100)
            })
            .map(|parsed| parsed.ok_or_else(|| anyhow::anyhow!("Invalid status")))
            .transpose()?;
        let uri = match self.url {
            Some(url) => {
                let uri: Uri = url.trim().parse()?;
                if uri.scheme().is_none() || uri.host().is_none() {
                    anyhow::bail!("The URL must be absolute");
                }
                Some(uri)
            }
            None => None,
        };
        let headers = match self.headers {
            Some(list) => {
                if list.len() > 200 {
                    anyhow::bail!("Too many headers");
                }
                let mut map = HeaderMap::new();
                for (name, value) in list {
                    map.append(
                        HeaderName::from_bytes(name.trim().as_bytes())?,
                        HeaderValue::from_str(value.trim())?,
                    );
                }
                Some(map)
            }
            None => None,
        };
        let body = match (self.base64, self.text) {
            (Some(encoded), _) => Some(BASE64_STANDARD.decode(encoded.trim())?),
            (None, Some(text)) => Some(text.into_bytes()),
            (None, None) => None,
        };
        if body.as_ref().is_some_and(|b| b.len() > BODY_LIMIT) {
            anyhow::bail!("Body too large");
        }
        Ok(Edit {
            drop,
            method,
            uri,
            status,
            headers,
            body,
        })
    }
}

struct Held {
    view: HeldView,
    decide: oneshot::Sender<Edit>,
}

#[derive(Default)]
pub struct State {
    rules: Rules,
    next_id: u64,
    queue: VecDeque<Held>,
}
pub type Shared = Arc<Mutex<State>>;

impl State {
    /// Validates the patterns; switching off forwards everything held, unchanged.
    pub fn set_rules(&mut self, rules: Rules) -> anyhow::Result<()> {
        if rules.hosts.len() > 200 {
            anyhow::bail!("Too many host patterns");
        }
        if rules.methods.len() > 20 {
            anyhow::bail!("Too many methods");
        }
        if rules.path.len() > 2048 {
            anyhow::bail!("Path pattern too long");
        }
        let hosts = rules
            .hosts
            .iter()
            .map(|pattern| crate::settings::host_pattern(pattern))
            .collect::<anyhow::Result<Vec<_>>>()?;
        let mut methods = Vec::new();
        for method in &rules.methods {
            let method = method.trim().to_uppercase();
            if method.is_empty() {
                continue;
            }
            if !method.bytes().all(|b| b.is_ascii_alphabetic()) {
                anyhow::bail!("Not a method name: {method}");
            }
            if !methods.contains(&method) {
                methods.push(method);
            }
        }
        self.rules = Rules {
            enabled: rules.enabled,
            hosts,
            responses: rules.responses,
            methods,
            path: rules.path.trim().to_lowercase(),
        };
        if !self.rules.enabled {
            self.release_all();
        }
        Ok(())
    }
    pub fn holds_response(&self, host: &str, method: &str, path: &str) -> bool {
        self.rules.responses && self.holds(host, method, path)
    }
    /// Whether a request to `host` with this method and path is held: every list that is
    /// empty matches everything.
    pub fn holds(&self, host: &str, method: &str, path: &str) -> bool {
        if !self.rules.enabled {
            return false;
        }
        let host = host.to_lowercase();
        let host_ok = self.rules.hosts.is_empty()
            || self
                .rules
                .hosts
                .iter()
                .any(|pattern| crate::settings::wildcard(pattern, &host));
        let method_ok = self.rules.methods.is_empty()
            || self
                .rules
                .methods
                .iter()
                .any(|m| m.eq_ignore_ascii_case(method));
        let path_ok = self.rules.path.is_empty() || path.to_lowercase().contains(&self.rules.path);
        host_ok && method_ok && path_ok
    }
    /// Drops entries whose request is gone (the client hung up while waiting), so the queue
    /// shows only requests that can still be answered.
    fn prune(&mut self) {
        self.queue.retain(|held| !held.decide.is_closed());
    }
    pub fn view(&mut self) -> serde_json::Value {
        self.prune();
        serde_json::json!({
            "enabled": self.rules.enabled,
            "hosts": self.rules.hosts,
            "responses": self.rules.responses,
            "methods": self.rules.methods,
            "path": self.rules.path,
            "held": self.queue.iter().map(|held| &held.view).collect::<Vec<_>>(),
        })
    }
    pub fn held(&mut self) -> usize {
        self.prune();
        self.queue.len()
    }
    /// Hands the decision to the waiting request; false when nothing with that id is held.
    pub fn decide(&mut self, id: u64, edit: Edit) -> bool {
        let Some(at) = self.queue.iter().position(|held| held.view.id == id) else {
            return false;
        };
        let held = self
            .queue
            .remove(at)
            .expect("the position came from the queue");
        let _ = held.decide.send(edit);
        true
    }
    pub fn release_all(&mut self) {
        for held in self.queue.drain(..) {
            let _ = held.decide.send(Edit::forward());
        }
    }
    fn forget(&mut self, id: u64) {
        self.queue.retain(|held| held.view.id != id);
    }
}

pub enum Outcome {
    Forward(Box<Request<Body>>),
    Drop {
        method: String,
        url: String,
        headers: Vec<(String, String)>,
    },
}

fn content_length(headers: &HeaderMap) -> Option<usize> {
    headers
        .get(CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
/// Queues a view and waits for the decision; the wait running out forwards unchanged.
async fn wait_for_decision(shared: &Shared, mut view: HeldView) -> Edit {
    let (sender, receiver) = oneshot::channel();
    let id = {
        let mut state = shared.lock().unwrap();
        state.next_id += 1;
        view.id = state.next_id;
        state.queue.push_back(Held {
            view,
            decide: sender,
        });
        state.next_id
    };
    match tokio::time::timeout(WAIT, receiver).await {
        Ok(Ok(edit)) => edit,
        _ => {
            shared.lock().unwrap().forget(id);
            Edit::forward()
        }
    }
}
/// Holds the request until the interface decides, or the wait runs out.
pub async fn hold(shared: &Shared, req: Request<Body>) -> Outcome {
    let (mut parts, body) = req.into_parts();
    let length = content_length(&parts.headers);
    // Only a body that can be buffered whole is held; a streaming or oversized upload passes.
    let bytes = if body.is_end_stream() {
        Vec::new()
    } else if length.is_some_and(|n| n <= BODY_LIMIT) {
        match body.collect().await {
            Ok(collected) => collected.to_bytes().to_vec(),
            Err(_) => {
                return Outcome::Forward(Box::new(Request::from_parts(
                    parts,
                    Body::from(Vec::new()),
                )));
            }
        }
    } else {
        return Outcome::Forward(Box::new(Request::from_parts(parts, body)));
    };
    let preview = &bytes[..bytes.len().min(PREVIEW)];
    let view = HeldView {
        id: 0,
        kind: "request",
        time: now_ms(),
        method: parts.method.to_string(),
        url: parts.uri.to_string(),
        status: None,
        headers: crate::capture::headers(&parts.headers),
        text: String::from_utf8_lossy(preview).into_owned(),
        base64: BASE64_STANDARD.encode(preview),
        size: bytes.len(),
        truncated: bytes.len() > PREVIEW,
        decoded: false,
    };
    let edit = wait_for_decision(shared, view).await;
    if edit.drop {
        return Outcome::Drop {
            method: parts.method.to_string(),
            url: parts.uri.to_string(),
            headers: crate::capture::headers(&parts.headers),
        };
    }
    if let Some(method) = edit.method {
        parts.method = method;
    }
    if let Some(uri) = edit.uri {
        parts.uri = uri;
    }
    if let Some(headers) = edit.headers {
        parts.headers = headers;
    }
    let body = edit.body.unwrap_or(bytes);
    // What goes out is whole and of known size: the length header has to say so.
    parts.headers.remove(TRANSFER_ENCODING);
    if body.is_empty() && !matches!(parts.method, Method::POST | Method::PUT | Method::PATCH) {
        parts.headers.remove(CONTENT_LENGTH);
    } else {
        parts
            .headers
            .insert(CONTENT_LENGTH, HeaderValue::from(body.len()));
    }
    Outcome::Forward(Box::new(Request::from_parts(parts, Body::from(body))))
}

pub enum ResponseOutcome {
    Forward(Box<Response<Body>>),
    Drop,
    /// The response could not be held (too large, or the stream broke); the reason goes to the client.
    Failed(&'static str),
}

/// Holds a response the same way. Bodies of unknown length are buffered up to the limit, since
/// most API responses arrive chunked; beyond it the response cannot be held and fails.
pub async fn hold_response(
    shared: &Shared,
    res: Response<Body>,
    method: String,
    url: String,
) -> ResponseOutcome {
    let (mut parts, body) = res.into_parts();
    let length = content_length(&parts.headers);
    let bytes = if body.is_end_stream() {
        Vec::new()
    } else if length.is_some_and(|n| n > BODY_LIMIT) {
        return ResponseOutcome::Forward(Box::new(Response::from_parts(parts, body)));
    } else {
        match http_body_util::Limited::new(body, BODY_LIMIT)
            .collect()
            .await
        {
            Ok(collected) => collected.to_bytes().to_vec(),
            Err(_) => {
                return ResponseOutcome::Failed(if length.is_none() { TOO_LARGE } else { FAILED });
            }
        }
    };
    let headers = crate::capture::headers(&parts.headers);
    let compressed = parts.headers.contains_key(CONTENT_ENCODING) && !bytes.is_empty();
    let text = crate::decode::preview(&headers, &bytes);
    let preview = &bytes[..bytes.len().min(PREVIEW)];
    let view = HeldView {
        id: 0,
        kind: "response",
        time: now_ms(),
        method,
        url,
        status: Some(parts.status.as_u16()),
        headers,
        truncated: bytes.len() > PREVIEW || (compressed && text.len() >= PREVIEW),
        text,
        base64: BASE64_STANDARD.encode(preview),
        size: bytes.len(),
        decoded: compressed,
    };
    let edit = wait_for_decision(shared, view).await;
    if edit.drop {
        return ResponseOutcome::Drop;
    }
    if let Some(status) = edit.status {
        parts.status = status;
    }
    if let Some(headers) = edit.headers {
        parts.headers = headers;
    }
    let edited = edit.body.is_some();
    let body = edit.body.unwrap_or(bytes);
    if edited {
        // An edited body is plain text: whatever compression the original had no longer applies.
        parts.headers.remove(CONTENT_ENCODING);
    }
    if edited || !body.is_empty() {
        parts.headers.remove(TRANSFER_ENCODING);
        parts
            .headers
            .insert(CONTENT_LENGTH, HeaderValue::from(body.len()));
    }
    ResponseOutcome::Forward(Box::new(Response::from_parts(parts, Body::from(body))))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_held_request_whose_client_left_disappears_and_decisions_reach_the_rest() {
        let mut state = State::default();
        let view = |id: u64| HeldView {
            id,
            kind: "request",
            time: 0,
            method: "GET".into(),
            url: "http://a.test/".into(),
            status: None,
            headers: vec![],
            text: String::new(),
            base64: String::new(),
            size: 0,
            truncated: false,
            decoded: false,
        };
        let (gone_sender, gone_receiver) = oneshot::channel();
        let (live_sender, live_receiver) = oneshot::channel();
        state.queue.push_back(Held {
            view: view(1),
            decide: gone_sender,
        });
        state.queue.push_back(Held {
            view: view(2),
            decide: live_sender,
        });
        drop(gone_receiver);
        assert_eq!(state.held(), 1, "the abandoned one is pruned");
        assert_eq!(state.view()["held"][0]["id"], 2);
        assert!(
            !state.decide(1, Edit::forward()),
            "nothing to decide for the pruned one"
        );
        assert!(state.decide(2, Edit::forward()));
        assert!(live_receiver.blocking_recv().is_ok_and(|edit| !edit.drop));
        assert_eq!(state.held(), 0);
        assert!(
            Decision {
                action: "forward".into(),
                status: Some(42),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            Decision {
                action: "forward".into(),
                url: Some("/relative".into()),
                ..Default::default()
            }
            .validate()
            .is_err(),
            "a relative URL cannot be proxied"
        );
    }
    #[test]
    fn rules_narrow_by_host_method_and_path() {
        let mut state = State::default();
        state
            .set_rules(Rules {
                enabled: true,
                hosts: vec!["*.example.test".into()],
                responses: false,
                methods: vec![" post ".into(), "PUT".into(), "post".into()],
                path: " /API/ ".into(),
            })
            .unwrap();
        assert_eq!(state.rules.methods, vec!["POST", "PUT"]);
        assert_eq!(state.rules.path, "/api/");
        assert!(state.holds("api.example.test", "POST", "/api/items"));
        assert!(state.holds("api.example.test", "put", "/v1/API/items"));
        assert!(
            !state.holds("api.example.test", "GET", "/api/items"),
            "method"
        );
        assert!(
            !state.holds("api.example.test", "POST", "/static/x"),
            "path"
        );
        assert!(!state.holds("other.test", "POST", "/api/items"), "host");
        assert!(!state.holds_response("api.example.test", "POST", "/api/"));
        assert!(
            state
                .set_rules(Rules {
                    enabled: true,
                    methods: vec!["GE T".into()],
                    ..Default::default()
                })
                .is_err()
        );
        state.set_rules(Rules::default()).unwrap();
        assert!(
            !state.holds("api.example.test", "POST", "/api/items"),
            "off"
        );
    }
}
