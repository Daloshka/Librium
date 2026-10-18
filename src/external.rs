//! Authenticated ingestion for desktop collectors (CDP and custom adapters).
use crate::{App, capture::SavedExchange, websocket::Message};
use axum::{Json, extract::State, http::StatusCode};
use base64::{Engine, prelude::BASE64_STANDARD};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    Exchange {
        exchange: Box<SavedExchange>,
        websocket: bool,
    },
    Message {
        id: u64,
        message: Message,
    },
    End {
        id: u64,
        error: Option<String>,
        close: Option<crate::websocket::CloseInfo>,
    },
}

pub async fn ingest(
    State(app): State<App>,
    Json(event): Json<Event>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let mut history = app.history.lock().unwrap();
    let fail = crate::storage_error;
    match event {
        Event::Exchange {
            mut exchange,
            websocket,
        } => {
            exchange.summary.source = match exchange.summary.source {
                crate::capture::Source::CdpNode => crate::capture::Source::CdpNode,
                crate::capture::Source::CdpChromium => crate::capture::Source::CdpChromium,
                _ => crate::capture::Source::External,
            };
            let url =
                url::Url::parse(&exchange.summary.url).map_err(|_| StatusCode::BAD_REQUEST)?;
            if !matches!(url.scheme(), "http" | "https" | "ws" | "wss")
                || url.host_str().is_none()
                || exchange.summary.url.len() > 16384
                || exchange.summary.method.len() > 32
                || exchange
                    .summary
                    .capture_context
                    .as_deref()
                    .is_some_and(|value| !crate::capture::valid_context(value))
                || exchange
                    .summary
                    .capture_target
                    .as_ref()
                    .is_some_and(|target| {
                        target.trim().is_empty()
                            || target.len() > 1024
                            || target.chars().count() > 256
                    })
                || exchange
                    .summary
                    .error
                    .as_ref()
                    .is_some_and(|e| e.len() > 4096)
                || (websocket && exchange.summary.status != Some(101))
                || (exchange.summary.ws_role.is_some()
                    && !websocket
                    && exchange.summary.status != Some(101)
                    && !matches!(url.scheme(), "ws" | "wss")
                    && !exchange.request.headers.iter().any(|(key, value)| {
                        key.eq_ignore_ascii_case("upgrade")
                            && value.eq_ignore_ascii_case("websocket")
                    }))
            {
                return Err(StatusCode::BAD_REQUEST);
            }
            for payload in [&exchange.request, &exchange.response] {
                if payload.headers.len() > 256
                    || payload
                        .headers
                        .iter()
                        .any(|(k, v)| k.len() + v.len() > 32768)
                    || payload.base64.len() > 87384
                    || payload.text.len() > 196608
                {
                    return Err(StatusCode::PAYLOAD_TOO_LARGE);
                }
                let bytes = BASE64_STANDARD
                    .decode(&payload.base64)
                    .map_err(|_| StatusCode::BAD_REQUEST)?;
                if bytes.len() > 65536
                    || payload.size < bytes.len()
                    || payload.truncated != (payload.size > bytes.len())
                {
                    return Err(StatusCode::BAD_REQUEST);
                }
            }
            exchange
                .request
                .headers
                .push(("x-librium-source".into(), "CDP / external adapter".into()));
            let id = history.import_capture(*exchange).map_err(fail)?;
            if websocket {
                history.store.as_ref().unwrap().ws_start(id).map_err(fail)?;
            }
            Ok(Json(serde_json::json!({"id":id})))
        }
        Event::Message { id, message } => {
            if !matches!(message.direction.as_str(), "sent" | "received")
                || !matches!(
                    message.kind.as_str(),
                    "TEXT" | "BINARY" | "PING" | "PONG" | "CLOSE" | "CONTINUATION"
                )
                || message.base64.len() > 87384
                || message.text.len() > 196608
            {
                return Err(StatusCode::BAD_REQUEST);
            }
            let bytes = BASE64_STANDARD
                .decode(&message.base64)
                .map_err(|_| StatusCode::BAD_REQUEST)?;
            if bytes.len() > 65536
                || message.size < bytes.len()
                || message.truncated != (message.size > bytes.len())
            {
                return Err(StatusCode::BAD_REQUEST);
            }
            let store = history
                .store
                .as_ref()
                .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
            if !store.external_ws_open(id).map_err(fail)? {
                return Err(StatusCode::CONFLICT);
            }
            store.ws_record(id, &message).map_err(fail)?;
            Ok(Json(serde_json::json!({"id":id})))
        }
        Event::End { id, error, close } => {
            if error.as_ref().is_some_and(|e| e.len() > 4096)
                || close.as_ref().is_some_and(|c| c.reason.len() > 4096)
                || close
                    .as_ref()
                    .and_then(|c| c.direction.as_deref())
                    .is_some_and(|d| !matches!(d, "sent" | "received"))
            {
                return Err(StatusCode::BAD_REQUEST);
            }
            let store = history
                .store
                .as_ref()
                .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
            let row = store
                .detail(id)
                .map_err(fail)?
                .ok_or(StatusCode::NOT_FOUND)?;
            if row.summary.source == crate::capture::Source::Proxy {
                return Err(StatusCode::CONFLICT);
            }
            store
                .ws_end_with_close(id, error, close.as_ref())
                .map_err(fail)?;
            Ok(Json(serde_json::json!({"id":id})))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{History, Shared};
    use serde_json::{Value, json};

    async fn send(app: &App, event: Value) -> Result<Value, StatusCode> {
        ingest(
            State(app.clone()),
            Json(serde_json::from_value(event).unwrap()),
        )
        .await
        .map(|Json(value)| value)
    }
    #[tokio::test]
    async fn external_capture_validates_sessions_preserves_bytes_and_survives_restart() {
        let dir = std::env::temp_dir().join(format!("librium-external-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.sqlite3");
        let history: Shared =
            std::sync::Arc::new(std::sync::Mutex::new(History::open(&path).unwrap()));
        let app = App {
            history: history.clone(),
            token: "fixture".into(),
            pem: String::new(),
        };
        let body =
            json!({"headers":[],"text":"","base64":"","size":0,"truncated":false,"complete":true});
        let event = json!({"event":"exchange","websocket":true,"exchange":{"summary":{"id":999,"time":1000,"method":"GET","url":"wss://example.test/custom","status":101,"elapsed_ms":1,"size":0,"error":null},"request":body,"response":body}});
        let id = send(&app, event.clone()).await.unwrap()["id"]
            .as_u64()
            .unwrap();
        assert_eq!(id, 1);
        let message = json!({"event":"message","id":id,"message":{"time":1001,"direction":"received","kind":"BINARY","text":"","base64":"AP8=","size":2,"truncated":false}});
        send(&app, message.clone()).await.unwrap();
        let mut invalid = message.clone();
        invalid["message"]["base64"] = json!("bad!");
        assert_eq!(
            send(&app, invalid).await.unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        let mut invalid = message.clone();
        invalid["message"]["size"] = json!(1);
        assert_eq!(
            send(&app, invalid).await.unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        let mut invalid = event.clone();
        invalid["exchange"]["summary"]["url"] = json!("file:///fixture");
        assert_eq!(
            send(&app, invalid).await.unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        let mut invalid = event.clone();
        invalid["exchange"]["summary"]["status"] = json!(200);
        assert_eq!(
            send(&app, invalid).await.unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        let close = json!({"code":4001,"reason":"Сессия завершена <script>"});
        assert_eq!(send(&app, json!({"event":"end","id":id,"error":null,"close":{"code":4001,"reason":"x".repeat(4097)}})).await.unwrap_err(), StatusCode::BAD_REQUEST);
        send(
            &app,
            json!({"event":"end","id":id,"error":null,"close":close}),
        )
        .await
        .unwrap();
        assert_eq!(
            send(&app, message.clone()).await.unwrap_err(),
            StatusCode::CONFLICT
        );
        let open = send(&app, event).await.unwrap()["id"].as_u64().unwrap();
        assert_eq!(open, 2);
        drop(app);
        drop(history);
        {
            let store = crate::storage::Store::open(&path).unwrap();
            assert_eq!(store.ws_page(id, None).unwrap()["close"], close);
            assert_eq!(
                store.ws_export_page(id, 0, None).unwrap().unwrap()["session"]["close"],
                close
            );
            assert!(store.ws_page(open, None).unwrap()["close"].is_null());
            assert_eq!(
                store.ws_page(id, None).unwrap()["messages"][0]["base64"],
                "AP8="
            );
            assert_eq!(store.ws_page(open, None).unwrap()["state"], "closed");
            assert!(!store.external_ws_open(open).unwrap());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
