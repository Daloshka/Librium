use crate::capture::{History, Shared};
use base64::{Engine, prelude::BASE64_STANDARD};
use hudsucker::tokio_tungstenite::tungstenite;
use serde::{Deserialize, Serialize};

#[derive(Serialize)]
pub struct Message {
    time: u128,
    direction: String,
    kind: String,
    text: String,
    base64: String,
    size: usize,
    truncated: bool,
}
impl Message {
    /// A frame as the history keeps it: the first 64 KiB of the data, as text unless binary.
    pub fn new(time: u128, direction: &str, kind: &str, data: &[u8]) -> Self {
        let bytes = &data[..data.len().min(65536)];
        Message {
            time,
            direction: direction.into(),
            kind: kind.into(),
            text: if kind == "BINARY" {
                String::new()
            } else {
                String::from_utf8_lossy(bytes).into_owned()
            },
            base64: BASE64_STANDARD.encode(bytes),
            size: data.len(),
            truncated: bytes.len() < data.len(),
        }
    }
    /// Approximate memory held by a queued frame, for the queue's byte budget.
    pub fn bytes(&self) -> usize {
        self.text.len() + self.base64.len() + self.direction.len() + self.kind.len() + 64
    }
}
/// Socket events are queued and written with the next history flush, so a chatty socket
/// costs one transaction per half second rather than a synchronous write per frame.
pub enum Event {
    Start(u64),
    Message(u64, Message),
    End(u64, Option<String>),
}
pub fn start(history: &Shared, id: u64) {
    start_in(&mut history.lock().unwrap(), id);
}
pub fn end(history: &Shared, id: u64, error: Option<String>) {
    end_in(&mut history.lock().unwrap(), id, error);
}
pub fn record(history: &Shared, id: u64, direction: &str, message: &tungstenite::Message) {
    record_in(&mut history.lock().unwrap(), id, direction, message);
}
pub fn start_in(history: &mut History, id: u64) {
    history.ws_event(Event::Start(id));
}
pub fn end_in(history: &mut History, id: u64, error: Option<String>) {
    history.ws_event(Event::End(id, error));
}
pub fn record_in(history: &mut History, id: u64, direction: &str, message: &tungstenite::Message) {
    let (kind, data) = match message {
        tungstenite::Message::Text(v) => ("TEXT", v.as_bytes().to_vec()),
        tungstenite::Message::Binary(v) => ("BINARY", v.to_vec()),
        tungstenite::Message::Ping(v) => ("PING", v.to_vec()),
        tungstenite::Message::Pong(v) => ("PONG", v.to_vec()),
        tungstenite::Message::Close(v) => (
            "CLOSE",
            v.as_ref()
                .map(|c| format!("{} {}", u16::from(c.code), c.reason))
                .unwrap_or_default()
                .into_bytes(),
        ),
        _ => return,
    };
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    history.ws_event(Event::Message(
        id,
        Message::new(time, direction, kind, &data),
    ));
}
/// A frame from outside (an imported HAR), as the desktop converter hands it over.
#[derive(Deserialize)]
pub struct ImportedFrame {
    pub time: u128,
    pub direction: String,
    pub kind: String,
    pub base64: String,
}
impl ImportedFrame {
    pub fn into_message(self) -> anyhow::Result<Message> {
        let data = BASE64_STANDARD.decode(&self.base64)?;
        let direction = if self.direction == "sent" {
            "sent"
        } else {
            "received"
        };
        let kind = match self.kind.as_str() {
            known @ ("TEXT" | "BINARY" | "PING" | "PONG" | "CLOSE") => known,
            _ => "BINARY",
        };
        Ok(Message::new(self.time, direction, kind, &data))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn messages_survive_restart_and_page_without_retention_limit() {
        let dir = std::env::temp_dir().join(format!("librium-ws-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.sqlite3");
        {
            let h = std::sync::Arc::new(std::sync::Mutex::new(
                crate::capture::History::open(&path).unwrap(),
            ));
            start(&h, 1);
            for i in 0..600 {
                record(
                    &h,
                    1,
                    "sent",
                    &tungstenite::Message::Text(format!("message {i}").into()),
                );
            }
            record(
                &h,
                1,
                "received",
                &tungstenite::Message::Binary(vec![255; 70000].into()),
            );
            // Frames are queued; a reader sees them only after a flush.
            let reader = crate::storage::Store::open_reader(&path).unwrap();
            assert_eq!(reader.ws_page(1, None, None).unwrap()["total"], 0);
            h.lock().unwrap().flush().unwrap();
            let page = reader.ws_page(1, None, None).unwrap();
            assert_eq!(page["total"], 601);
            assert_eq!(page["state"], "open");
            end(&h, 1, None);
            // Dropping the history flushes whatever is still queued.
        }
        {
            let store = crate::storage::Store::open(&path).unwrap();
            let page = store.ws_page(1, None, None).unwrap();
            assert_eq!(page["total"], 601);
            assert_eq!(page["messages"].as_array().unwrap().len(), 100);
            assert_eq!(page["older"], true);
            assert_eq!(page["state"], "closed");
            assert_eq!(page["error"], serde_json::Value::Null);
            let last = page["messages"].as_array().unwrap().last().unwrap();
            assert_eq!(last["kind"], "BINARY");
            assert_eq!(last["direction"], "received");
            assert_eq!(last["size"], 70000);
            assert_eq!(last["truncated"], true);
            let first = page["messages"][0]["id"].as_i64().unwrap();
            let older = store.ws_page(1, Some(first), None).unwrap();
            assert_eq!(older["messages"].as_array().unwrap().len(), 100);
            assert_eq!(older["messages"][0]["text"], "message 401");
            // Forward paging from the beginning, for exports.
            let forward = store.ws_page(1, None, Some(0)).unwrap();
            assert_eq!(forward["messages"][0]["text"], "message 0");
            assert_eq!(forward["messages"].as_array().unwrap().len(), 100);
            assert_eq!(forward["more"], true);
            let last = forward["messages"][99]["id"].as_i64().unwrap();
            let next = store.ws_page(1, None, Some(last)).unwrap();
            assert_eq!(next["messages"][0]["text"], "message 100");
            let tail = store.ws_page(1, None, Some(last + 495)).unwrap();
            assert_eq!(tail["messages"].as_array().unwrap().len(), 6);
            assert_eq!(tail["more"], false);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
