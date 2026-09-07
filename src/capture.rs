use base64::{Engine, prelude::BASE64_STANDARD};
use http_body_util::BodyExt;
use hudsucker::hyper::body::Body as _;
use hudsucker::{
    Body, HttpContext, HttpHandler, RequestOrResponse,
    hyper::{HeaderMap, Method, Request, Response},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const MEMORY_CACHE: usize = 200;
const PREVIEW_LIMIT: usize = 64 * 1024;
const MEDIA_LIMIT: usize = 32 * 1024 * 1024;

#[derive(Default, Serialize)]
pub struct Payload {
    pub headers: Vec<(String, String)>,
    #[serde(skip)]
    bytes: Vec<u8>,
    #[serde(skip)]
    limit: usize,
    pub size: usize,
    pub complete: bool,
}

impl Payload {
    fn append(&mut self, data: &[u8]) {
        self.size += data.len();
        let remaining = self
            .limit
            .max(PREVIEW_LIMIT)
            .saturating_sub(self.bytes.len());
        self.bytes
            .extend_from_slice(&data[..data.len().min(remaining)]);
    }
    pub fn view(&self) -> PayloadView {
        PayloadView {
            headers: self.headers.clone(),
            text: String::from_utf8_lossy(&self.bytes[..self.bytes.len().min(PREVIEW_LIMIT)])
                .into_owned(),
            base64: BASE64_STANDARD.encode(&self.bytes),
            size: self.size,
            truncated: self.size > self.bytes.len(),
            complete: self.complete,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct PayloadView {
    pub headers: Vec<(String, String)>,
    text: String,
    base64: String,
    size: usize,
    truncated: bool,
    complete: bool,
}

pub struct Exchange {
    pub id: u64,
    pub time: u64,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub elapsed_ms: Option<u128>,
    pub error: Option<String>,
    pub request: Payload,
    pub response: Payload,
    started: Instant,
    dirty: bool,
}

#[derive(Serialize, Deserialize)]
pub struct Summary {
    pub id: u64,
    pub time: u64,
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
    pub elapsed_ms: Option<u128>,
    pub size: usize,
    pub error: Option<String>,
}
impl Exchange {
    pub fn saved(&self) -> SavedExchange {
        SavedExchange {
            summary: self.summary(),
            request: self.request.view(),
            response: self.response.view(),
        }
    }

    pub fn summary(&self) -> Summary {
        Summary {
            id: self.id,
            time: self.time,
            method: self.method.clone(),
            url: self.url.clone(),
            status: self.status,
            elapsed_ms: self.elapsed_ms,
            size: self.response.size,
            error: self.error.clone(),
        }
    }
}

#[derive(Default)]
pub struct History {
    pub rows: VecDeque<Exchange>,
    next_id: u64,
    pub store: Option<crate::storage::Store>,
}
pub type Shared = Arc<Mutex<History>>;

#[derive(Serialize, Deserialize)]
pub struct SavedExchange {
    pub summary: Summary,
    pub request: PayloadView,
    pub response: PayloadView,
}
impl History {
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let store = crate::storage::Store::open(path)?;
        Ok(Self {
            next_id: store.max_id()?,
            store: Some(store),
            ..Self::default()
        })
    }
    pub fn flush(&mut self) -> anyhow::Result<()> {
        let Some(store) = &mut self.store else {
            return Ok(());
        };
        let pending: Vec<_> = self
            .rows
            .iter()
            .filter(|r| r.dirty)
            .map(Exchange::saved)
            .collect();
        if !pending.is_empty() {
            store.save(&pending)?;
        }
        for row in &mut self.rows {
            row.dirty = false;
        }
        let cutoff = self.next_id.saturating_sub(MEMORY_CACHE as u64);
        self.rows.retain(|r| {
            r.id > cutoff || (r.error.is_none() && !(r.request.complete && r.response.complete))
        });
        let mut cached_bytes = 0;
        let mut remove = std::collections::HashSet::new();
        for row in self.rows.iter().rev() {
            cached_bytes += row.request.bytes.len() + row.response.bytes.len();
            if cached_bytes > 64 * 1024 * 1024
                && (row.error.is_some() || (row.request.complete && row.response.complete))
            {
                remove.insert(row.id);
            }
        }
        self.rows.retain(|r| !remove.contains(&r.id));
        Ok(())
    }
    pub fn clear(&mut self) -> anyhow::Result<()> {
        if let Some(store) = &mut self.store {
            store.clear()?;
        }
        self.rows.clear();
        Ok(())
    }

    pub fn restore_json(&mut self, json: &str) -> anyhow::Result<()> {
        let mut saved: Vec<SavedExchange> = serde_json::from_str(json)?;
        saved.sort_by_key(|row| row.summary.id);
        for row in saved {
            let payload = |view: PayloadView| -> anyhow::Result<Payload> {
                let mut bytes = BASE64_STANDARD.decode(view.base64)?;
                bytes.truncate(MEDIA_LIMIT);
                Ok(Payload {
                    headers: view.headers,
                    limit: bytes.len().max(PREVIEW_LIMIT),
                    bytes,
                    size: view.size,
                    complete: view.complete,
                })
            };
            self.next_id = self.next_id.max(row.summary.id);
            self.rows.push_back(Exchange {
                id: row.summary.id,
                time: row.summary.time,
                method: row.summary.method,
                url: row.summary.url,
                status: row.summary.status,
                elapsed_ms: row.summary.elapsed_ms,
                error: row.summary.error.or_else(|| {
                    (!row.response.complete)
                        .then(|| "Соединение завершено при обновлении Librium".into())
                }),
                request: payload(row.request)?,
                response: payload(row.response)?,
                started: Instant::now(),
                dirty: true,
            });
        }
        Ok(())
    }
}

fn headers(h: &HeaderMap) -> Vec<(String, String)> {
    h.iter()
        .map(|(k, v)| {
            (
                k.to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect()
}

// Observe frames as they pass through: uploads, downloads and SSE stay streaming.
// map_frame preserves data and trailers and does not decompress or alter the wire body.
fn observe(body: Body, history: Shared, id: u64, response: bool) -> Body {
    let complete = body.is_end_stream();
    if complete && let Some(row) = history.lock().unwrap().rows.iter_mut().find(|r| r.id == id) {
        row.dirty = true;
        if response {
            row.response.complete = true;
        } else {
            row.request.complete = true;
        }
    }
    let completion_history = history.clone();
    let observer = body.map_frame(move |frame| {
        if let Some(data) = frame.data_ref()
            && let Some(row) = history.lock().unwrap().rows.iter_mut().find(|r| r.id == id)
        {
            let payload = if response {
                &mut row.response
            } else {
                &mut row.request
            };
            payload.append(data);
            row.dirty = true;
        }
        frame
    });
    // A wrapper tracks EOF/errors as well as frames, including chunked bodies.
    Body::from(http_body_util::combinators::BoxBody::new(Completion {
        inner: Box::pin(observer),
        history: completion_history,
        id,
        response,
    }))
}

// Completion is implemented separately so polling never buffers an entire body.
struct Completion<B> {
    inner: std::pin::Pin<Box<B>>,
    history: Shared,
    id: u64,
    response: bool,
}
impl<B> Drop for Completion<B> {
    fn drop(&mut self) {
        if let Some(row) = self
            .history
            .lock()
            .unwrap()
            .rows
            .iter_mut()
            .find(|r| r.id == self.id)
        {
            let complete = if self.response {
                row.response.complete
            } else {
                row.request.complete
            };
            if !complete {
                row.error
                    .get_or_insert_with(|| "Передача прервана до получения полного тела".into());
                row.dirty = true;
            }
        }
    }
}
impl<
    B: hudsucker::hyper::body::Body<Data = hudsucker::hyper::body::Bytes, Error = hudsucker::Error>,
> hudsucker::hyper::body::Body for Completion<B>
{
    type Data = hudsucker::hyper::body::Bytes;
    type Error = hudsucker::Error;
    fn poll_frame(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<hudsucker::hyper::body::Frame<Self::Data>, Self::Error>>>
    {
        let result = self.inner.as_mut().poll_frame(cx);
        if (self.inner.is_end_stream()
            || matches!(
                &result,
                std::task::Poll::Ready(None) | std::task::Poll::Ready(Some(Err(_)))
            ))
            && let Some(row) = self
                .history
                .lock()
                .unwrap()
                .rows
                .iter_mut()
                .find(|r| r.id == self.id)
        {
            row.dirty = true;
            if let std::task::Poll::Ready(Some(Err(err))) = &result {
                row.error = Some(err.to_string());
            } else if self.response {
                row.response.complete = true;
            } else {
                row.request.complete = true;
            }
        }
        result
    }
    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }
    fn size_hint(&self) -> hudsucker::hyper::body::SizeHint {
        self.inner.size_hint()
    }
}

#[derive(Clone)]
pub struct Capture {
    pub history: Shared,
    pub current: Option<u64>,
    pub control_ports: [u16; 3],
}
impl HttpHandler for Capture {
    async fn handle_request(&mut self, ctx: &HttpContext, req: Request<Body>) -> RequestOrResponse {
        if req
            .uri()
            .port_u16()
            .is_some_and(|port| self.control_ports.contains(&port))
        {
            return Response::builder()
                .status(403)
                .body(Body::from(
                    "Librium control ports are not proxy destinations",
                ))
                .unwrap()
                .into();
        }
        if req.method() == Method::CONNECT {
            return req.into();
        }
        let id = {
            let mut history = self.history.lock().unwrap();
            history.next_id += 1;
            let id = history.next_id;
            history.rows.push_back(Exchange {
                id,
                time: SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                method: req.method().to_string(),
                url: req.uri().to_string(),
                status: None,
                elapsed_ms: None,
                error: None,
                started: Instant::now(),
                dirty: true,
                request: Payload {
                    headers: headers(req.headers()),
                    ..Default::default()
                },
                response: Payload::default(),
            });
            id
        };
        self.current = Some(id);
        if hyper_tungstenite::is_upgrade_request(&req) {
            let response = websocket_handshake(req, self.history.clone(), id).await;
            return self.handle_response(ctx, response).await.into();
        }
        let (parts, body) = req.into_parts();
        let req = Request::from_parts(parts, observe(body, self.history.clone(), id, false));
        req.into()
    }
    async fn handle_response(&mut self, _: &HttpContext, res: Response<Body>) -> Response<Body> {
        let Some(id) = self.current else {
            return res;
        };
        if let Some(row) = self
            .history
            .lock()
            .unwrap()
            .rows
            .iter_mut()
            .find(|r| r.id == id)
        {
            row.dirty = true;
            row.status = Some(res.status().as_u16());
            row.elapsed_ms = Some(row.started.elapsed().as_millis());
            row.response.headers = headers(res.headers());
            let media = res
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .is_some_and(|h| {
                    h.starts_with("image/")
                        || h.starts_with("audio/")
                        || h.starts_with("application/ogg")
                })
                || row.url.split('?').next().is_some_and(|u| {
                    [
                        ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".avif",
                        ".ogg", ".oga", ".mp3", ".wav", ".flac", ".m4a", ".aac", ".opus",
                    ]
                    .iter()
                    .any(|ext| u.to_lowercase().ends_with(ext))
                });
            if media {
                row.response.limit = MEDIA_LIMIT;
            }
        }
        if res.status() == 101 {
            if let Some(row) = self
                .history
                .lock()
                .unwrap()
                .rows
                .iter_mut()
                .find(|r| r.id == id)
            {
                row.request.complete = true;
                row.response.complete = true;
                row.error = None;
                row.dirty = true;
            }
            return res;
        }
        let (parts, body) = res.into_parts();
        Response::from_parts(parts, observe(body, self.history.clone(), id, true))
    }
    async fn handle_error(
        &mut self,
        _: &HttpContext,
        err: hudsucker::hyper_util::client::legacy::Error,
    ) -> Response<Body> {
        if let Some(row) = self
            .history
            .lock()
            .unwrap()
            .rows
            .iter_mut()
            .find(|r| Some(r.id) == self.current)
        {
            row.dirty = true;
            row.status = Some(502);
            row.error = Some(format!("{err:?}"));
            row.elapsed_ms = Some(row.started.elapsed().as_millis());
        }
        Response::builder()
            .status(502)
            .body(Body::from("Librium: upstream connection failed"))
            .unwrap()
    }
}

// Finish the upstream handshake first. A refused upgrade must be returned as
// its real HTTP status, rather than a false 101 followed by a dropped socket.
async fn websocket_handshake(mut req: Request<Body>, history: Shared, id: u64) -> Response<Body> {
    use hudsucker::{
        futures::StreamExt,
        tokio_tungstenite::{connect_async, tungstenite},
    };
    let mut uri = req.uri().clone().into_parts();
    uri.scheme = Some(
        if req.uri().scheme_str() == Some("https") {
            "wss"
        } else {
            "ws"
        }
        .parse()
        .unwrap(),
    );
    let mut upstream = Request::new(());
    *upstream.uri_mut() = hudsucker::hyper::Uri::from_parts(uri).unwrap();
    *upstream.headers_mut() = req.headers().clone();
    // tungstenite forwards decoded messages and does not implement permessage-deflate.
    upstream.headers_mut().remove("sec-websocket-extensions");
    let connected =
        tokio::time::timeout(std::time::Duration::from_secs(15), connect_async(upstream)).await;
    match connected {
        Ok(Ok((server_socket, upstream_response))) => {
            match hyper_tungstenite::upgrade(&mut req, None) {
                Ok((mut response, client_socket)) => {
                    if let Some(protocol) =
                        upstream_response.headers().get("sec-websocket-protocol")
                    {
                        response
                            .headers_mut()
                            .insert("sec-websocket-protocol", protocol.clone());
                    }
                    crate::websocket::start(&history, id);
                    tokio::spawn(async move {
                        let result=async {
                            let client_socket=client_socket.await?;
                            let (server_sink, server_stream) = server_socket.split();
                            let (client_sink, client_stream) = client_socket.split();
                            tokio::select! {
                                result=client_stream.map(|m|{if let Ok(msg)=&m{crate::websocket::record(&history,id,"sent",msg);}m}).forward(server_sink)=>result,
                                result=server_stream.map(|m|{if let Ok(msg)=&m{crate::websocket::record(&history,id,"received",msg);}m}).forward(client_sink)=>result,
                            }
                        }.await;
                        crate::websocket::end(&history, id, result.err().map(|e| e.to_string()));
                    });
                    response.map(Body::from)
                }
                Err(_) => Response::builder()
                    .status(400)
                    .body(Body::from("Invalid WebSocket handshake"))
                    .unwrap(),
            }
        }
        Ok(Err(tungstenite::Error::Http(response))) => {
            let (parts, body) = response.into_parts();
            Response::from_parts(parts, Body::from(body.unwrap_or_default()))
        }
        Ok(Err(_)) => Response::builder()
            .status(502)
            .body(Body::from("WebSocket upstream connection failed"))
            .unwrap(),
        Err(_) => Response::builder()
            .status(504)
            .body(Body::from("WebSocket upstream handshake timed out"))
            .unwrap(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn image_preview_retains_more_than_64_kib_without_unbounded_text() {
        let mut payload = Payload {
            limit: MEDIA_LIMIT,
            ..Payload::default()
        };
        payload.append(&vec![42; 256 * 1024]);
        assert_eq!(payload.bytes.len(), 256 * 1024);
        let view = payload.view();
        assert!(!view.truncated);
        assert_eq!(
            BASE64_STANDARD.decode(view.base64).unwrap().len(),
            256 * 1024
        );
        assert_eq!(view.text.len(), PREVIEW_LIMIT);
    }
    #[tokio::test]
    async fn capture_preserves_body_and_bounds_preview() {
        let history = Shared::default();
        let bytes = vec![0xff; PREVIEW_LIMIT + 100];
        history.lock().unwrap().rows.push_back(Exchange {
            id: 1,
            time: 0,
            method: "POST".into(),
            url: "http://localhost/upload".into(),
            status: None,
            elapsed_ms: None,
            error: None,
            started: Instant::now(),
            dirty: true,
            request: Payload::default(),
            response: Payload::default(),
        });
        let body = observe(Body::from(bytes.clone()), history.clone(), 1, false);
        assert_eq!(body.collect().await.unwrap().to_bytes(), bytes);
        let h = history.lock().unwrap();
        let view = h.rows[0].request.view();
        assert_eq!(view.size, PREVIEW_LIMIT + 100);
        assert!(view.truncated);
    }
}
