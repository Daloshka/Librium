use base64::{Engine, prelude::BASE64_STANDARD};
use http_body_util::BodyExt;
use hudsucker::hyper::body::Body as _;
use hudsucker::{
    Body, HttpContext, HttpHandler, RequestOrResponse,
    hyper::{
        HeaderMap, Method, Request, Response,
        header::{HeaderName, HeaderValue},
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

const MEMORY_CACHE: usize = 200;
pub const PREVIEW_LIMIT: usize = 64 * 1024;
const MEDIA_LIMIT: usize = 32 * 1024 * 1024;
// WebSocket frames wait for the next flush. If the database keeps failing, the oldest frames
// are dropped once this many bytes are queued; session starts and ends are always kept, since a
// frame without its session row would never be stored at all.
const WS_PENDING_BYTES: usize = 64 * 1024 * 1024;
// A client that goes away while the upstream is still silent leaves no trace in the handler
// callbacks, so an exchange without any response is given up after this long.
const RESPONSE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

#[derive(Default, Serialize)]
pub struct Payload {
    pub headers: Vec<(String, String)>,
    #[serde(skip)]
    bytes: Vec<u8>,
    #[serde(skip)]
    limit: usize,
    pub size: usize,
    /// Every byte arrived.
    pub complete: bool,
    /// No more bytes will arrive: complete, failed, or the stream was dropped.
    #[serde(skip)]
    ended: bool,
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
    pub(crate) fn view_within(&self, limit: usize) -> PayloadView {
        let kept = &self.bytes[..self.bytes.len().min(limit)];
        PayloadView {
            headers: self.headers.clone(),
            text: crate::decode::preview(&self.headers, kept),
            base64: BASE64_STANDARD.encode(kept),
            size: self.size,
            truncated: self.size > kept.len(),
            complete: self.complete,
        }
    }
}

#[derive(Serialize, Deserialize)]
pub struct PayloadView {
    pub headers: Vec<(String, String)>,
    pub text: String,
    pub base64: String,
    pub size: usize,
    pub truncated: bool,
    pub complete: bool,
}

pub struct Exchange {
    pub id: u64,
    pub time: u64,
    pub method: String,
    pub url: String,
    /// Protocol the client spoke to the proxy, e.g. "HTTP/2"; the upstream leg may differ.
    pub version: String,
    /// Response media type without parameters, lowercase, e.g. "application/json".
    pub content_type: String,
    pub status: Option<u16>,
    pub elapsed_ms: Option<u128>,
    pub error: Option<String>,
    pub request: Payload,
    pub response: Payload,
    /// Marked by the user: a star to find it again, a note to remember why.
    pub starred: bool,
    pub note: String,
    pub mock: bool,
    started: Instant,
    dirty: bool,
}

#[derive(Serialize, Deserialize)]
pub struct Summary {
    pub id: u64,
    pub time: u64,
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub content_type: String,
    pub status: Option<u16>,
    pub elapsed_ms: Option<u128>,
    pub size: usize,
    pub error: Option<String>,
    /// Nothing about this exchange will change any more. Rows written before the flag existed
    /// are static by definition, so a missing value reads as true.
    #[serde(default = "finished_default")]
    pub finished: bool,
    #[serde(default)]
    pub starred: bool,
    #[serde(default)]
    pub note: String,
    /// Answered by a mock instead of the origin.
    #[serde(default)]
    pub mock: bool,
}
fn finished_default() -> bool {
    true
}
impl Exchange {
    /// Everything captured so far, whatever its state; the API prefers `stored`, which previews
    /// a body that is still streaming.
    #[cfg(test)]
    pub fn saved(&self) -> SavedExchange {
        self.saved_within(usize::MAX)
    }
    /// What goes to disk. While an exchange is still streaming only the preview is stored,
    /// so a large download is not re-encoded and rewritten on every flush; the full body
    /// is written once when the transfer ends. The inspector reads streaming rows from memory.
    pub fn stored(&self) -> SavedExchange {
        self.saved_within(if self.streaming() {
            PREVIEW_LIMIT
        } else {
            usize::MAX
        })
    }
    /// Both directions have ended; an error on one side does not stop the other from streaming.
    pub fn finished(&self) -> bool {
        self.request.ended && self.response.ended
    }
    pub fn streaming(&self) -> bool {
        !self.finished()
    }
    /// Changed since the last successful write.
    #[cfg(test)]
    pub fn unsaved(&self) -> bool {
        self.dirty
    }
    fn saved_within(&self, limit: usize) -> SavedExchange {
        SavedExchange {
            summary: self.summary(),
            request: self.request.view_within(limit),
            response: self.response.view_within(limit),
        }
    }

    pub fn summary(&self) -> Summary {
        Summary {
            id: self.id,
            time: self.time,
            method: self.method.clone(),
            url: self.url.clone(),
            version: self.version.clone(),
            content_type: self.content_type.clone(),
            status: self.status,
            elapsed_ms: self.elapsed_ms,
            size: self.response.size,
            error: self.error.clone(),
            finished: self.finished(),
            starred: self.starred,
            note: self.note.clone(),
            mock: self.mock,
        }
    }
}

#[derive(Default)]
pub struct History {
    /// Ordered by id: exchanges are appended as they start and `retain` keeps the order.
    pub rows: VecDeque<Exchange>,
    next_id: u64,
    /// Grows whenever the stored history changes, so an idle interface can poll one number
    /// instead of re-running its queries every second.
    pub revision: u64,
    /// The last failure to write the history, cleared by the next successful flush, so the
    /// interface can say that capture continues but nothing is being saved.
    pub storage_error: Option<String>,
    /// Set once a store was opened. The store itself is absent while a flush writes it out.
    persistent: bool,
    pub store: Option<crate::storage::Store>,
    /// Session starts and ends: a handful per socket, never dropped.
    ws_control: Vec<crate::websocket::Event>,
    /// Frames, bounded by WS_PENDING_BYTES.
    ws_frames: VecDeque<crate::websocket::Event>,
    ws_frame_bytes: usize,
}
pub type Shared = Arc<Mutex<History>>;

/// One flush in flight: what to write, taken out of the history so that the write itself
/// happens without the lock and capture keeps recording meanwhile.
pub struct Flush {
    store: crate::storage::Store,
    ids: Vec<u64>,
    rows: Vec<SavedExchange>,
    control: Vec<crate::websocket::Event>,
    frames: VecDeque<crate::websocket::Event>,
    frame_bytes: usize,
}
impl Flush {
    fn changed(&self) -> bool {
        !(self.rows.is_empty() && self.control.is_empty() && self.frames.is_empty())
    }
    pub fn write(&self) -> anyhow::Result<()> {
        use crate::websocket::Event;
        if !self.changed() {
            return Ok(());
        }
        // Starts first, so every frame finds its session row; ends last, so a socket that
        // opened and closed between two flushes is stored with all of its frames.
        let starts = self.control.iter().filter(|e| matches!(e, Event::Start(_)));
        let ends = self.control.iter().filter(|e| matches!(e, Event::End(..)));
        self.store
            .save(&self.rows, starts.chain(self.frames.iter()).chain(ends))
    }
}
/// Flushes with the lock held only while collecting and while recording the outcome: a slow
/// disk or a database another process is holding never stalls the proxy.
pub fn flush_shared(shared: &Shared) -> anyhow::Result<()> {
    let Some(flush) = shared.lock().unwrap().begin_flush() else {
        return Ok(());
    };
    let result = flush.write();
    shared.lock().unwrap().end_flush(flush, result)
}
/// Removes every stored exchange the search matches. The rows still only in memory are written
/// first; the deletion itself runs with the store taken out of the history, so a large purge
/// does not hold up capture; then memory and the queued socket events forget the ids.
pub fn delete_matching_shared(
    shared: &Shared,
    search: &crate::storage::Search,
) -> anyhow::Result<usize> {
    flush_shared(shared)?;
    let mut store = with_writer(shared, |history| {
        Ok(history
            .store
            .take()
            .expect("with_writer guarantees the store"))
    })?;
    let result = store.delete_matching(search);
    let mut history = shared.lock().unwrap();
    history.store = Some(store);
    let ids: std::collections::HashSet<u64> = result?.into_iter().collect();
    history.forget(&ids);
    Ok(ids.len())
}
/// Runs `task` with the store present, waiting out a flush that is in flight.
pub fn with_writer<T>(
    shared: &Shared,
    task: impl FnOnce(&mut History) -> anyhow::Result<T>,
) -> anyhow::Result<T> {
    let deadline = Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let mut history = shared.lock().unwrap();
        if history.store.is_some() || !history.persistent {
            return task(&mut history);
        }
        drop(history);
        if Instant::now() > deadline {
            anyhow::bail!("History storage is busy");
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[derive(Serialize, Deserialize)]
pub struct SavedExchange {
    pub summary: Summary,
    pub request: PayloadView,
    pub response: PayloadView,
}
/// An exchange from outside, with the WebSocket frames that belong to it.
#[derive(Deserialize)]
pub struct ImportedExchange {
    pub summary: Summary,
    pub request: PayloadView,
    pub response: PayloadView,
    #[serde(default)]
    pub frames: Vec<crate::websocket::ImportedFrame>,
}
impl History {
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let store = crate::storage::Store::open(path)?;
        let mut history = Self::default();
        history.next_id = store.max_id()?;
        history.persistent = true;
        history.store = Some(store);
        Ok(history)
    }
    pub fn row(&self, id: u64) -> Option<&Exchange> {
        let index = self.rows.partition_point(|r| r.id < id);
        self.rows.get(index).filter(|r| r.id == id)
    }
    pub fn row_mut(&mut self, id: u64) -> Option<&mut Exchange> {
        let index = self.rows.partition_point(|r| r.id < id);
        self.rows.get_mut(index).filter(|r| r.id == id)
    }
    pub fn ws_event(&mut self, event: crate::websocket::Event) {
        use crate::websocket::Event;
        if !self.persistent {
            return;
        }
        match event {
            Event::Message(_, ref message) => {
                self.ws_frame_bytes += message.bytes();
                self.ws_frames.push_back(event);
                self.trim_frames();
            }
            control => self.ws_control.push(control),
        }
    }
    fn trim_frames(&mut self) {
        use crate::websocket::Event;
        while self.ws_frame_bytes > WS_PENDING_BYTES
            && let Some(Event::Message(_, dropped)) = self.ws_frames.pop_front()
        {
            self.ws_frame_bytes -= dropped.bytes();
        }
    }
    /// Takes everything that has to be written, together with the store, out of the history.
    /// The caller writes it with `Flush::write` without holding the lock and hands the result
    /// back to `end_flush`. None when there is no store or another flush is in flight.
    pub fn begin_flush(&mut self) -> Option<Flush> {
        let store = self.store.take()?;
        let mut ids = Vec::new();
        let mut rows = Vec::new();
        for row in &mut self.rows {
            if row.dirty {
                row.dirty = false;
                ids.push(row.id);
                rows.push(row.stored());
            }
        }
        Some(Flush {
            store,
            ids,
            rows,
            control: std::mem::take(&mut self.ws_control),
            frames: std::mem::take(&mut self.ws_frames),
            frame_bytes: std::mem::replace(&mut self.ws_frame_bytes, 0),
        })
    }
    pub fn end_flush(&mut self, flush: Flush, result: anyhow::Result<()>) -> anyhow::Result<()> {
        let changed = flush.changed();
        self.store = Some(flush.store);
        if let Err(error) = result {
            // Nothing reached the disk: the rows are dirty again and the queued socket events
            // go back in front of whatever arrived while the write was failing.
            for id in flush.ids {
                if let Some(row) = self.row_mut(id) {
                    row.dirty = true;
                }
            }
            let mut control = flush.control;
            control.append(&mut self.ws_control);
            self.ws_control = control;
            let mut frames = flush.frames;
            frames.append(&mut self.ws_frames);
            self.ws_frames = frames;
            self.ws_frame_bytes += flush.frame_bytes;
            self.trim_frames();
            self.storage_error = Some(error.to_string());
            return Err(error);
        }
        if changed {
            self.revision += 1;
        }
        self.storage_error = None;
        self.evict();
        Ok(())
    }
    /// Complete, saved exchanges leave memory beyond the last MEMORY_CACHE ids or 64 MiB of
    /// bodies; anything still streaming or not yet written stays.
    fn evict(&mut self) {
        for row in &mut self.rows {
            if row.status.is_none() && !row.finished() && row.started.elapsed() > RESPONSE_TIMEOUT {
                row.error
                    .get_or_insert_with(|| "No response before the connection was closed".into());
                row.request.ended = true;
                row.response.ended = true;
                row.dirty = true;
            }
        }
        let cutoff = self.next_id.saturating_sub(MEMORY_CACHE as u64);
        self.rows
            .retain(|r| r.dirty || r.id > cutoff || r.streaming());
        let mut cached_bytes = 0;
        let mut remove = std::collections::HashSet::new();
        for row in self.rows.iter().rev() {
            cached_bytes += row.request.bytes.len() + row.response.bytes.len();
            if cached_bytes > 64 * 1024 * 1024 && !row.dirty && !row.streaming() {
                remove.insert(row.id);
            }
        }
        self.rows.retain(|r| !remove.contains(&r.id));
    }
    /// Writes under the lock; for tests and for the moments when the lock is held anyway.
    pub fn flush(&mut self) -> anyhow::Result<()> {
        match self.begin_flush() {
            Some(flush) => {
                let result = flush.write();
                self.end_flush(flush, result)
            }
            None => Ok(()),
        }
    }
    /// The final flush before exit, followed by a WAL checkpoint so the file on disk is complete.
    pub fn close(&mut self) -> anyhow::Result<()> {
        self.flush()?;
        if let Some(store) = &self.store {
            store.checkpoint()?;
        }
        Ok(())
    }
    /// Forgets one exchange everywhere: memory, queued socket events and the store.
    pub fn delete(&mut self, id: u64) -> anyhow::Result<bool> {
        use crate::websocket::Event;
        let in_memory = self.row(id).is_some();
        self.rows.retain(|r| r.id != id);
        self.ws_control
            .retain(|e| !matches!(e, Event::Start(x) | Event::End(x, _) if *x == id));
        let before = self.ws_frames.len();
        self.ws_frames
            .retain(|e| !matches!(e, Event::Message(x, _) if *x == id));
        if self.ws_frames.len() != before {
            self.ws_frame_bytes = self
                .ws_frames
                .iter()
                .map(|e| match e {
                    Event::Message(_, m) => m.bytes(),
                    _ => 0,
                })
                .sum();
        }
        let stored = match &mut self.store {
            Some(store) => store.delete(id)?,
            None => false,
        };
        if in_memory || stored {
            self.revision += 1;
        }
        Ok(in_memory || stored)
    }
    /// Drops exchanges the store no longer has from memory and from the queued socket events.
    pub fn forget(&mut self, ids: &std::collections::HashSet<u64>) {
        use crate::websocket::Event;
        if ids.is_empty() {
            return;
        }
        self.rows.retain(|r| !ids.contains(&r.id));
        self.ws_control
            .retain(|e| !matches!(e, Event::Start(x) | Event::End(x, _) if ids.contains(x)));
        self.ws_frames
            .retain(|e| !matches!(e, Event::Message(x, _) if ids.contains(x)));
        self.ws_frame_bytes = self
            .ws_frames
            .iter()
            .map(|e| match e {
                Event::Message(_, m) => m.bytes(),
                _ => 0,
            })
            .sum();
        self.revision += 1;
    }
    pub fn clear(&mut self) -> anyhow::Result<()> {
        if let Some(store) = &mut self.store {
            store.clear()?;
        }
        self.rows.clear();
        self.ws_control.clear();
        self.ws_frames.clear();
        self.ws_frame_bytes = 0;
        self.revision += 1;
        Ok(())
    }

    pub fn restore_json(&mut self, json: &str) -> anyhow::Result<()> {
        let mut saved: Vec<SavedExchange> = serde_json::from_str(json)?;
        saved.sort_by_key(|row| row.summary.id);
        for row in saved {
            self.adopt_one(row)?;
        }
        self.rows.make_contiguous().sort_by_key(|r| r.id);
        Ok(())
    }
    /// Exchanges from elsewhere (an imported HAR): they get fresh ids, are final as they are,
    /// and their frames go through the queue like a captured socket's. Written out along the
    /// way, so a large import neither holds everything in memory nor overflows the frame budget.
    pub fn import(&mut self, rows: Vec<ImportedExchange>) -> anyhow::Result<usize> {
        use crate::websocket::Event;
        // Fresh ids start above everything ever handed out: in memory, in the store
        // (which remembers the highest id even after deletes) and by the counter.
        let in_memory = self.rows.iter().map(|r| r.id).max().unwrap_or(0);
        let stored = match &self.store {
            Some(store) => store.max_id()?,
            None => 0,
        };
        self.next_id = self.next_id.max(in_memory).max(stored);
        let count = rows.len();
        for (n, row) in rows.into_iter().enumerate() {
            self.next_id += 1;
            let id = self.next_id;
            let mut exchange = SavedExchange {
                summary: row.summary,
                request: row.request,
                response: row.response,
            };
            exchange.summary.id = id;
            self.adopt_one(exchange)?;
            if !row.frames.is_empty() {
                self.ws_event(Event::Start(id));
                for frame in row.frames {
                    self.ws_event(Event::Message(id, frame.into_message()?));
                }
                self.ws_event(Event::End(id, None));
            }
            if n % 1000 == 999 || self.ws_frame_bytes > WS_PENDING_BYTES / 2 {
                self.flush()?;
            }
        }
        self.rows.make_contiguous().sort_by_key(|r| r.id);
        Ok(count)
    }
    fn adopt_one(&mut self, mut row: SavedExchange) -> anyhow::Result<()> {
        let payload = |view: PayloadView| -> anyhow::Result<Payload> {
            let mut bytes = BASE64_STANDARD.decode(view.base64)?;
            bytes.truncate(MEDIA_LIMIT);
            Ok(Payload {
                headers: view.headers,
                limit: bytes.len().max(PREVIEW_LIMIT),
                bytes,
                size: view.size,
                complete: view.complete,
                ended: true,
            })
        };
        self.next_id = self.next_id.max(row.summary.id);
        self.rows.push_back(Exchange {
            id: row.summary.id,
            time: row.summary.time,
            method: row.summary.method,
            url: row.summary.url,
            version: row.summary.version,
            content_type: row.summary.content_type,
            status: row.summary.status,
            elapsed_ms: row.summary.elapsed_ms,
            error: row.summary.error.or_else(|| {
                (!row.response.complete).then(|| "Connection ended when Librium was updated".into())
            }),
            request: payload(row.request)?,
            response: payload(row.response)?,
            starred: row.summary.starred,
            note: std::mem::take(&mut row.summary.note),
            mock: row.summary.mock,
            started: Instant::now(),
            dirty: true,
        });
        Ok(())
    }
}
impl History {
    /// Stars or annotates an exchange: in memory when it is cached (the next flush writes it),
    /// and in the store right away. False when no such exchange exists anywhere.
    pub fn mark(
        &mut self,
        id: u64,
        starred: Option<bool>,
        note: Option<&str>,
    ) -> anyhow::Result<bool> {
        let cached = if let Some(row) = self.row_mut(id) {
            if let Some(starred) = starred {
                row.starred = starred;
            }
            if let Some(note) = note {
                row.note = note.to_string();
            }
            row.dirty = true;
            true
        } else {
            false
        };
        let stored = match &self.store {
            Some(store) => store.mark(id, starred, note)?,
            None => false,
        };
        if stored && !cached {
            self.revision += 1;
        }
        Ok(cached || stored)
    }
}
impl Drop for History {
    fn drop(&mut self) {
        // The last chance for the final half second of traffic; errors were already reported.
        let _ = self.flush();
    }
}

/// A response still streaming with `body` captured so far; for the API tests.
#[cfg(test)]
pub fn test_exchange(id: u64, body: &[u8]) -> Exchange {
    let mut row = Exchange {
        id,
        time: 0,
        method: "GET".into(),
        url: "https://example.test/big.bin".into(),
        version: "HTTP/1.1".into(),
        content_type: "application/octet-stream".into(),
        status: Some(200),
        elapsed_ms: Some(1),
        error: None,
        request: Payload {
            complete: true,
            ended: true,
            ..Payload::default()
        },
        response: Payload {
            limit: MEDIA_LIMIT,
            ..Payload::default()
        },
        starred: false,
        note: String::new(),
        mock: false,
        started: Instant::now(),
        dirty: true,
    };
    row.response.append(body);
    row
}
impl Exchange {
    /// Marks both directions as complete; for tests.
    #[cfg(test)]
    pub fn finish(&mut self) {
        for payload in [&mut self.request, &mut self.response] {
            payload.complete = true;
            payload.ended = true;
        }
        self.dirty = true;
    }
}
fn version_label(version: hudsucker::hyper::Version) -> String {
    use hudsucker::hyper::Version;
    match version {
        Version::HTTP_09 => "HTTP/0.9",
        Version::HTTP_10 => "HTTP/1.0",
        Version::HTTP_11 => "HTTP/1.1",
        Version::HTTP_2 => "HTTP/2",
        Version::HTTP_3 => "HTTP/3",
        _ => "",
    }
    .into()
}
fn media_type(headers: &HeaderMap) -> String {
    headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_lowercase())
        .unwrap_or_default()
}
pub(crate) fn headers(h: &HeaderMap) -> Vec<(String, String)> {
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
    if complete && let Some(row) = history.lock().unwrap().row_mut(id) {
        row.dirty = true;
        let payload = if response {
            &mut row.response
        } else {
            &mut row.request
        };
        payload.complete = true;
        payload.ended = true;
    }
    let completion_history = history.clone();
    let observer = body.map_frame(move |frame| {
        if let Some(data) = frame.data_ref()
            && let Some(row) = history.lock().unwrap().row_mut(id)
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
        if let Some(row) = self.history.lock().unwrap().row_mut(self.id) {
            let payload = if self.response {
                &mut row.response
            } else {
                &mut row.request
            };
            if !payload.ended {
                payload.ended = true;
                row.dirty = true;
                if !payload.complete {
                    row.error.get_or_insert_with(|| {
                        "Transfer interrupted before the full body arrived".into()
                    });
                }
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
            && let Some(row) = self.history.lock().unwrap().row_mut(self.id)
        {
            row.dirty = true;
            let payload = if self.response {
                &mut row.response
            } else {
                &mut row.request
            };
            payload.ended = true;
            if let std::task::Poll::Ready(Some(Err(err))) = &result {
                row.error = Some(err.to_string());
            } else {
                payload.complete = true;
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
    pub settings: Arc<std::sync::RwLock<crate::settings::Settings>>,
    pub intercept: crate::intercept::Shared,
    /// Off: traffic still flows and the rules still apply, but nothing is held or recorded.
    pub recording: Arc<std::sync::atomic::AtomicBool>,
}
impl Capture {
    /// A held response that was dropped or could not be held: the exchange ends as an error and
    /// the client gets a 502 saying why.
    fn fail_held(&mut self, id: u64, reason: &'static str) -> Response<Body> {
        self.current = None;
        if let Some(row) = self.history.lock().unwrap().row_mut(id) {
            row.dirty = true;
            row.status = None;
            row.elapsed_ms = Some(row.started.elapsed().as_millis());
            row.error = Some(reason.into());
            row.response.complete = true;
            row.response.ended = true;
        }
        Response::builder()
            .status(502)
            .body(Body::from(reason))
            .unwrap()
    }
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
        // Ignored hosts are proxied as usual and simply not recorded: the rules below (mocks,
        // rewrites, delays) still apply to them, the same as while recording is off.
        let ignored = req
            .uri()
            .host()
            .is_some_and(|host| self.settings.read().unwrap().ignores(host));
        // A mock answers here, without the origin; the exchange is recorded like a real one so
        // the history shows what the app got.
        let mock = match req.uri().host() {
            Some(host) if !hyper_tungstenite::is_upgrade_request(&req) => {
                // The guard must not outlive this statement: reading the upload below awaits.
                let settings = self.settings.read().unwrap();
                settings
                    .mock_for(
                        host,
                        req.method().as_str(),
                        req.uri().path_and_query().map_or("/", |p| p.as_str()),
                    )
                    .cloned()
                    .map(|mock| {
                        let rewrites = settings
                            .response_rewrites_for(host, req.uri().path())
                            .into_iter()
                            .cloned()
                            .collect::<Vec<_>>();
                        (mock, settings.delay_for(host, req.uri().path()), rewrites)
                    })
            }
            _ => None,
        };
        let recording = !ignored && self.recording.load(std::sync::atomic::Ordering::Relaxed);
        if let Some((mock, delay, rewrites)) = mock {
            self.current = None;
            // The slow-network delay applies to mocks too, or a mocked app would feel instant.
            let started = Instant::now();
            if let Some(ms) = delay {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            }
            let mut response_headers = vec![
                ("content-type".to_string(), mock.content_type.clone()),
                ("content-length".to_string(), mock.body.len().to_string()),
                ("x-librium-mock".to_string(), "1".to_string()),
            ];
            // Response rewrites apply to mocks as to real answers, so a CORS or CSP rule holds.
            for rule in rewrites {
                response_headers.retain(|(name, _)| *name != rule.name);
                if !rule.value.is_empty() {
                    response_headers.push((rule.name, rule.value));
                }
            }
            let mut response = Payload {
                headers: response_headers.clone(),
                complete: true,
                ended: true,
                ..Default::default()
            };
            response.append(mock.body.as_bytes());
            // The upload is read so the history shows what the app sent; an oversized one is
            // recorded as cut short rather than buffered whole.
            let (parts, body) = req.into_parts();
            let mut request = Payload {
                headers: headers(&parts.headers),
                ended: true,
                ..Default::default()
            };
            match http_body_util::Limited::new(body, crate::intercept::BODY_LIMIT)
                .collect()
                .await
            {
                Ok(collected) => {
                    request.append(&collected.to_bytes());
                    request.complete = true;
                }
                Err(_) => request.complete = false,
            }
            let mut history = self.history.lock().unwrap();
            history.next_id += 1;
            let id = history.next_id;
            if recording {
                history.rows.push_back(Exchange {
                    id,
                    time: SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64,
                    method: parts.method.to_string(),
                    url: parts.uri.to_string(),
                    version: version_label(parts.version),
                    content_type: mock
                        .content_type
                        .split(';')
                        .next()
                        .unwrap_or_default()
                        .trim()
                        .to_lowercase(),
                    status: Some(mock.status),
                    elapsed_ms: Some(started.elapsed().as_millis()),
                    error: None,
                    starred: false,
                    note: String::new(),
                    mock: true,
                    started: Instant::now(),
                    dirty: true,
                    request,
                    response,
                });
            }
            drop(history);
            let mut builder = Response::builder().status(mock.status);
            for (name, value) in &response_headers {
                builder = builder.header(name.as_str(), value.as_str());
            }
            return builder
                .body(Body::from(mock.body.into_bytes()))
                .unwrap_or_else(|_| {
                    Response::builder()
                        .status(500)
                        .body(Body::from("Mock could not be built"))
                        .unwrap()
                })
                .into();
        }
        // Header rewrites for the host come before the request is recorded, so the history
        // shows what actually left the proxy. Names and values were validated when saved.
        let mut req = req;
        if let Some(host) = req.uri().host().map(str::to_owned) {
            let settings = self.settings.read().unwrap();
            for rule in settings.rewrites_for(&host, req.uri().path()) {
                let Ok(name) = HeaderName::from_bytes(rule.name.as_bytes()) else {
                    continue;
                };
                if rule.value.is_empty() {
                    req.headers_mut().remove(&name);
                } else if let Ok(value) = HeaderValue::from_str(&rule.value) {
                    req.headers_mut().insert(name, value);
                }
            }
        }
        // Recording off, or an ignored host: the request leaves with its rewrites, unheld and unrecorded.
        if !recording {
            self.current = None;
            return req.into();
        }
        // Intercept: held for the interface to edit, forward or drop. Upgrades are not held,
        // the socket handshake needs them as they are.
        if let Some(host) = req.uri().host().map(str::to_owned)
            && self
                .intercept
                .lock()
                .unwrap()
                .holds(&host, req.method().as_str(), req.uri().path())
            && !hyper_tungstenite::is_upgrade_request(&req)
        {
            let version = version_label(req.version());
            match crate::intercept::hold(&self.intercept, req).await {
                crate::intercept::Outcome::Forward(next) => req = *next,
                crate::intercept::Outcome::Drop {
                    method,
                    url,
                    headers,
                } => {
                    // The drop is recorded as a failed exchange, so it is visible in the history.
                    self.current = None;
                    let mut history = self.history.lock().unwrap();
                    history.next_id += 1;
                    let id = history.next_id;
                    history.rows.push_back(Exchange {
                        id,
                        time: SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                        method,
                        url,
                        version,
                        content_type: String::new(),
                        status: None,
                        elapsed_ms: None,
                        error: Some(crate::intercept::DROPPED.into()),
                        starred: false,
                        note: String::new(),
                        mock: false,
                        started: Instant::now(),
                        dirty: true,
                        request: Payload {
                            headers,
                            complete: true,
                            ended: true,
                            ..Default::default()
                        },
                        response: Payload {
                            complete: true,
                            ended: true,
                            ..Default::default()
                        },
                    });
                    return Response::builder()
                        .status(502)
                        .body(Body::from(crate::intercept::DROPPED))
                        .unwrap()
                        .into();
                }
            }
        }
        // An upgrade request carries no body: it is complete as soon as it is seen.
        let upgrade = hyper_tungstenite::is_upgrade_request(&req);
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
                version: version_label(req.version()),
                content_type: String::new(),
                status: None,
                elapsed_ms: None,
                error: None,
                starred: false,
                note: String::new(),
                mock: false,
                started: Instant::now(),
                dirty: true,
                request: Payload {
                    headers: headers(req.headers()),
                    complete: upgrade,
                    ended: upgrade,
                    ..Default::default()
                },
                response: Payload::default(),
            });
            id
        };
        self.current = Some(id);
        if upgrade {
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
        let mut res = res;
        // Response intercept comes first, so the history records what the client got.
        let held_for = {
            let history = self.history.lock().unwrap();
            history.row(id).and_then(|row| {
                let uri = row.url.parse::<hudsucker::hyper::Uri>().ok()?;
                let host = uri.host()?.to_owned();
                Some((
                    host,
                    uri.path().to_owned(),
                    row.method.clone(),
                    row.url.clone(),
                ))
            })
        };
        let response_target = held_for
            .as_ref()
            .map(|(host, path, ..)| (host.clone(), path.clone()));
        if let Some((host, path, method, url)) = held_for
            && res.status() != 101
            && self
                .intercept
                .lock()
                .unwrap()
                .holds_response(&host, &method, &path)
        {
            use crate::intercept::ResponseOutcome;
            match crate::intercept::hold_response(&self.intercept, res, method, url).await {
                ResponseOutcome::Forward(next) => res = *next,
                ResponseOutcome::Drop => return self.fail_held(id, crate::intercept::DROPPED),
                ResponseOutcome::Failed(reason) => return self.fail_held(id, reason),
            }
        }
        // Response rewrites, so the history records the headers the client actually got; then
        // the artificial delay, which the recorded duration includes on purpose.
        if let Some((host, path)) = response_target
            && res.status() != 101
        {
            let (rules, delay) = {
                let settings = self.settings.read().unwrap();
                (
                    settings
                        .response_rewrites_for(&host, &path)
                        .into_iter()
                        .cloned()
                        .collect::<Vec<_>>(),
                    settings.delay_for(&host, &path),
                )
            };
            if let Some(ms) = delay {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
            }
            for rule in rules {
                let Ok(name) = HeaderName::from_bytes(rule.name.as_bytes()) else {
                    continue;
                };
                if rule.value.is_empty() {
                    res.headers_mut().remove(&name);
                } else if let Ok(value) = HeaderValue::from_str(&rule.value) {
                    res.headers_mut().insert(name, value);
                }
            }
        }
        if let Some(row) = self.history.lock().unwrap().row_mut(id) {
            row.dirty = true;
            row.status = Some(res.status().as_u16());
            row.elapsed_ms = Some(row.started.elapsed().as_millis());
            row.response.headers = headers(res.headers());
            row.content_type = media_type(res.headers());
            let media = row.content_type.starts_with("image/")
                || row.content_type.starts_with("audio/")
                || row.content_type.starts_with("application/ogg")
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
            if let Some(row) = self.history.lock().unwrap().row_mut(id) {
                for payload in [&mut row.request, &mut row.response] {
                    payload.complete = true;
                    payload.ended = true;
                }
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
        if let Some(id) = self.current
            && let Some(row) = self.history.lock().unwrap().row_mut(id)
        {
            row.dirty = true;
            row.status = Some(502);
            row.error = Some(format!("{err:?}"));
            row.elapsed_ms = Some(row.started.elapsed().as_millis());
            row.request.ended = true;
            row.response.ended = true;
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
    fn exchange(id: u64) -> Exchange {
        Exchange {
            id,
            time: 0,
            method: "POST".into(),
            url: "http://localhost/upload".into(),
            version: "HTTP/1.1".into(),
            content_type: String::new(),
            status: None,
            elapsed_ms: None,
            error: None,
            starred: false,
            note: String::new(),
            mock: false,
            started: Instant::now(),
            dirty: true,
            request: Payload::default(),
            response: Payload::default(),
        }
    }
    #[test]
    fn image_preview_retains_more_than_64_kib_without_unbounded_text() {
        let mut payload = Payload {
            limit: MEDIA_LIMIT,
            ..Payload::default()
        };
        payload.append(&vec![42; 256 * 1024]);
        assert_eq!(payload.bytes.len(), 256 * 1024);
        let view = payload.view_within(usize::MAX);
        assert!(!view.truncated);
        assert_eq!(
            BASE64_STANDARD.decode(view.base64).unwrap().len(),
            256 * 1024
        );
        assert_eq!(view.text.len(), PREVIEW_LIMIT);
    }
    #[test]
    fn streaming_exchange_stores_only_its_preview_until_it_ends() {
        let mut row = exchange(1);
        row.response.limit = MEDIA_LIMIT;
        row.response.append(&vec![7; 3 * PREVIEW_LIMIT]);
        row.request.complete = true;
        row.request.ended = true;
        let stored = row.stored();
        assert!(stored.response.truncated);
        assert_eq!(
            BASE64_STANDARD
                .decode(stored.response.base64)
                .unwrap()
                .len(),
            PREVIEW_LIMIT
        );
        assert_eq!(
            BASE64_STANDARD
                .decode(row.saved().response.base64)
                .unwrap()
                .len(),
            3 * PREVIEW_LIMIT,
            "the inspector must still see everything captured"
        );
        row.response.complete = true;
        row.response.ended = true;
        assert!(row.finished());
        let stored = row.stored();
        assert!(!stored.response.truncated);
        assert_eq!(
            BASE64_STANDARD
                .decode(stored.response.base64)
                .unwrap()
                .len(),
            3 * PREVIEW_LIMIT
        );
    }
    #[test]
    fn rows_are_found_by_id_after_restores_and_evictions() {
        let mut history = History::default();
        for id in [5, 9, 12] {
            history.rows.push_back(exchange(id));
        }
        assert_eq!(history.row(9).map(|r| r.id), Some(9));
        assert!(history.row(10).is_none());
        assert!(history.row(1).is_none());
        assert!(history.row(13).is_none());
        history.rows.retain(|r| r.id != 9);
        assert!(history.row_mut(9).is_none());
        assert_eq!(history.row_mut(12).map(|r| r.id), Some(12));
    }
    #[tokio::test]
    async fn a_dropped_upload_does_not_end_the_exchange_while_the_response_streams() {
        let history = Shared::default();
        history.lock().unwrap().rows.push_back(exchange(1));
        // The server answers early and stops reading the upload: the request body is dropped unread.
        let upload = observe(Body::from(vec![1; 10]), history.clone(), 1, false);
        drop(upload);
        {
            let h = history.lock().unwrap();
            let row = h.row(1).unwrap();
            assert!(row.request.ended);
            assert!(!row.request.complete);
            assert_eq!(
                row.error.as_deref(),
                Some("Transfer interrupted before the full body arrived")
            );
            assert!(!row.finished(), "the response has not ended yet");
            assert!(row.streaming());
        }
        let response = observe(Body::from(vec![2; 10]), history.clone(), 1, true);
        response.collect().await.unwrap();
        let h = history.lock().unwrap();
        let row = h.row(1).unwrap();
        assert!(row.response.complete && row.response.ended);
        assert!(row.finished());
        assert!(row.summary().finished);
    }
    #[test]
    fn socket_frames_are_bounded_by_bytes_but_starts_and_ends_are_kept() {
        let mut history = History::open(std::path::Path::new(":memory:")).unwrap();
        crate::websocket::start_in(&mut history, 1);
        let frame =
            || hudsucker::tokio_tungstenite::tungstenite::Message::Binary(vec![9; 60_000].into());
        // Roughly 80 KiB queued per frame once base64-encoded: well past the 64 MiB budget.
        for _ in 0..1200 {
            crate::websocket::record_in(&mut history, 1, "sent", &frame());
        }
        crate::websocket::end_in(&mut history, 1, Some("closed by test".into()));
        assert!(history.ws_frame_bytes <= WS_PENDING_BYTES);
        assert!(
            history.ws_frames.len() < 1200,
            "the oldest frames were dropped"
        );
        assert_eq!(history.ws_control.len(), 2, "start and end survive");
        history.flush().unwrap();
        let page = history
            .store
            .as_ref()
            .unwrap()
            .ws_page(1, None, None)
            .unwrap();
        assert_eq!(page["state"], "closed");
        assert_eq!(page["error"], "closed by test");
        assert!(page["total"].as_i64().unwrap() > 300);
        assert!(history.ws_frames.is_empty() && history.ws_control.is_empty());
    }
    #[tokio::test]
    async fn capture_preserves_body_and_bounds_preview() {
        let history = Shared::default();
        let bytes = vec![0xff; PREVIEW_LIMIT + 100];
        history.lock().unwrap().rows.push_back(exchange(1));
        let body = observe(Body::from(bytes.clone()), history.clone(), 1, false);
        assert_eq!(body.collect().await.unwrap().to_bytes(), bytes);
        let h = history.lock().unwrap();
        let view = h.rows[0].request.view_within(usize::MAX);
        assert_eq!(view.size, PREVIEW_LIMIT + 100);
        assert!(view.truncated);
    }
}
