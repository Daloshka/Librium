use crate::capture::Shared;
use base64::{Engine, prelude::BASE64_STANDARD};
use hudsucker::tokio_tungstenite::tungstenite;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Serialize)]
pub struct CloseInfo {
    pub code: u16,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
}

// A successful end of one forwarding stream is only half of a close handshake.
// Keep polling the peer so its final CLOSE / transport error is not discarded.
pub async fn relay_halves<A, B>(
    a: A,
    b: B,
    close_timeout: std::time::Duration,
) -> Result<(), tungstenite::Error>
where
    A: std::future::Future<Output = Result<(), tungstenite::Error>>,
    B: std::future::Future<Output = Result<(), tungstenite::Error>>,
{
    tokio::pin!(a, b);
    let a_finished = tokio::select! {
        result = &mut a => {result?; true},
        result = &mut b => {result?; false},
    };
    tokio::time::timeout(close_timeout, async {
        if a_finished { b.await } else { a.await }
    })
    .await
    .map_err(|_| {
        tungstenite::Error::Io(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!(
                "WebSocket: другая сторона не завершила закрытие за {} мс",
                close_timeout.as_millis()
            ),
        ))
    })?
}

#[derive(Deserialize, Serialize)]
pub struct Message {
    pub time: u64,
    pub direction: String,
    pub kind: String,
    pub text: String,
    pub base64: String,
    pub size: usize,
    pub truncated: bool,
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
#[cfg(test)]
pub fn record(history: &Shared, id: u64, direction: &str, message: &tungstenite::Message) {
    let (kind, data) = match message {
        tungstenite::Message::Text(v) => ("TEXT", v.as_bytes().to_vec()),
        tungstenite::Message::Binary(v) => ("BINARY", v.to_vec()),
        tungstenite::Message::Ping(v) => ("PING", v.to_vec()),
        tungstenite::Message::Pong(v) => ("PONG", v.to_vec()),
        tungstenite::Message::Close(v) => (
            "CLOSE",
            v.as_ref()
                .map(|c| {
                    let mut bytes = u16::from(c.code).to_be_bytes().to_vec();
                    bytes.extend_from_slice(c.reason.as_bytes());
                    bytes
                })
                .unwrap_or_default(),
        ),
        _ => return,
    };
    record_bytes(history, id, direction, kind, &data, data.len());
}
pub fn record_bytes(
    history: &Shared,
    id: u64,
    direction: &str,
    kind: &str,
    data: &[u8],
    size: usize,
) {
    let bytes = &data[..data.len().min(65536)];

    let message = Message {
        time: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        direction: direction.into(),
        kind: kind.into(),
        text: if kind == "CLOSE" {
            if data.len() >= 2 {
                format!(
                    "{} {}",
                    u16::from_be_bytes([data[0], data[1]]),
                    String::from_utf8_lossy(&data[2..])
                )
            } else {
                String::new()
            }
        } else if kind == "BINARY" {
            String::new()
        } else {
            String::from_utf8_lossy(bytes).into_owned()
        },
        base64: BASE64_STANDARD.encode(bytes),
        size,
        truncated: bytes.len() < size,
    };
    let h = history.lock().unwrap();
    if let Some(store) = &h.store {
        if kind == "CLOSE" && data.len() >= 2 {
            let close = CloseInfo {
                code: u16::from_be_bytes([data[0], data[1]]),
                reason: String::from_utf8_lossy(&data[2..]).into_owned(),
                direction: Some(direction.into()),
            };
            if let Err(e) = store.ws_close(id, &close) {
                eprintln!("WebSocket storage: {e}");
            }
        }
        if let Err(e) = store.ws_record(id, &message) {
            eprintln!("WebSocket storage: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn relay_keeps_peer_alive_after_normal_half_close_and_bounds_wait() {
        use std::time::Duration;
        for first_a in [true, false] {
            let peer_finished = std::cell::Cell::new(false);
            let (tx, rx) = tokio::sync::oneshot::channel();
            let peer = async {
                rx.await.unwrap();
                peer_finished.set(true);
                Ok(())
            };
            let first = async {
                tx.send(()).unwrap();
                Ok(())
            };
            if first_a {
                relay_halves(first, peer, Duration::from_secs(1))
                    .await
                    .unwrap();
            } else {
                relay_halves(peer, first, Duration::from_secs(1))
                    .await
                    .unwrap();
            }
            assert!(peer_finished.get());
        }
        let result = relay_halves(
            async { Ok(()) },
            std::future::pending(),
            Duration::from_millis(20),
        )
        .await;
        assert!(
            matches!(result, Err(tungstenite::Error::Io(error)) if error.kind()==std::io::ErrorKind::TimedOut)
        );
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            relay_halves(
                async {
                    Err(tungstenite::Error::Io(std::io::Error::from(
                        std::io::ErrorKind::ConnectionReset,
                    )))
                },
                std::future::pending(),
                Duration::from_secs(10),
            ),
        )
        .await
        .unwrap();
        assert!(
            matches!(result, Err(tungstenite::Error::Io(error)) if error.kind()==std::io::ErrorKind::ConnectionReset)
        );
    }
    #[test]
    fn close_preserves_wire_code_and_reason_bytes() {
        let dir = std::env::temp_dir().join(format!("librium-close-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        {
            let history = std::sync::Arc::new(std::sync::Mutex::new(
                crate::capture::History::open(&dir.join("history.sqlite3")).unwrap(),
            ));
            start(&history, 1);
            record(
                &history,
                1,
                "received",
                &tungstenite::Message::Close(Some(tungstenite::protocol::CloseFrame {
                    code: tungstenite::protocol::frame::coding::CloseCode::Normal,
                    reason: "done".into(),
                })),
            );
            end(&history, 1, None);
            let h = history.lock().unwrap();
            let page = h.store.as_ref().unwrap().ws_page(1, None).unwrap();
            assert_eq!(page["messages"][0]["text"], "1000 done");
            assert_eq!(
                page["messages"][0]["base64"],
                BASE64_STANDARD.encode([3, 232, b'd', b'o', b'n', b'e'])
            );
            assert_eq!(page["messages"][0]["size"], 6);
            assert_eq!(
                page["close"],
                serde_json::json!({"code":1000,"reason":"done","direction":"received"})
            );
            assert_eq!(page["state"], "closed");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
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
            let found = store.ws_search(1, None, "message 12", "TEXT").unwrap();
            assert_eq!(found["matched"], 11);
            assert_eq!(found["messages"][0]["text"], "message 12");
            assert_eq!(found["older"], false);
            assert_eq!(
                store.ws_search(1, None, "% OR 1=1", "").unwrap()["matched"],
                0
            );
            assert_eq!(
                store.ws_search(1, None, "", "BINARY").unwrap()["matched"],
                1
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
