use crate::capture::Shared;
use base64::{Engine, prelude::BASE64_STANDARD};
use hudsucker::tokio_tungstenite::tungstenite;
use serde::Serialize;

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
pub fn start(history: &Shared, id: u64) {
    let mut h = history.lock().unwrap();
    if let Err(e) = h.flush() {
        eprintln!("WebSocket storage: {e}");
    }
    if let Some(store) = &h.store
        && let Err(e) = store.ws_start(id)
    {
        eprintln!("WebSocket storage: {e}");
    }
}
pub fn end(history: &Shared, id: u64, error: Option<String>) {
    let h = history.lock().unwrap();
    if let Some(store) = &h.store
        && let Err(e) = store.ws_end(id, error)
    {
        eprintln!("WebSocket storage: {e}");
    }
}
pub fn record(history: &Shared, id: u64, direction: &str, message: &tungstenite::Message) {
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
    let bytes = &data[..data.len().min(65536)];
    let message = Message {
        time: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
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
    };
    let h = history.lock().unwrap();
    if let Some(store) = &h.store
        && let Err(e) = store.ws_record(id, &message)
    {
        eprintln!("WebSocket storage: {e}");
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
            end(&h, 1, None);
        }
        {
            let store = crate::storage::Store::open(&path).unwrap();
            let page = store.ws_page(1, None).unwrap();
            assert_eq!(page["total"], 601);
            assert_eq!(page["messages"].as_array().unwrap().len(), 100);
            assert_eq!(page["older"], true);
            assert_eq!(page["state"], "closed");
            let last = page["messages"].as_array().unwrap().last().unwrap();
            assert_eq!(last["kind"], "BINARY");
            assert_eq!(last["direction"], "received");
            assert_eq!(last["size"], 70000);
            assert_eq!(last["truncated"], true);
            let first = page["messages"][0]["id"].as_i64().unwrap();
            let older = store.ws_page(1, Some(first)).unwrap();
            assert_eq!(older["messages"].as_array().unwrap().len(), 100);
            assert_eq!(older["messages"][0]["text"], "message 401");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
