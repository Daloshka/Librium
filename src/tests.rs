use super::*;
use axum::routing::post;
use std::time::Duration;

#[tokio::test]
async fn websocket_snapshot_scan_releases_capture_lock_and_keeps_consistent_results() {
    use base64::{Engine, prelude::BASE64_STANDARD};
    let file = std::env::temp_dir().join(format!(
        "librium-ws-reader-{}.sqlite3",
        uuid::Uuid::new_v4()
    ));
    let history = std::sync::Arc::new(std::sync::Mutex::new(
        capture::History::open(&file).unwrap(),
    ));
    let text = r#"{"state":"ready"}"#;
    let message = || websocket::Message {
        time: 1,
        direction: "sent".into(),
        kind: "TEXT".into(),
        text: text.into(),
        base64: BASE64_STANDARD.encode(text),
        size: text.len(),
        truncated: false,
    };
    {
        let mut h = history.lock().unwrap();
        let body = serde_json::json!({"headers":[],"base64":"","text":"","size":0,"truncated":false,"complete":true});
        let saved=serde_json::from_value(serde_json::json!({"summary":{"id":0,"source":"external","time":1,"method":"GET","url":"ws://fixture.invalid/reader","status":101,"elapsed_ms":0,"size":0,"error":null},"request":body,"response":body})).unwrap();
        assert_eq!(h.import_capture(saved).unwrap(), 1);
        let store = h.store.as_ref().unwrap();
        store.ws_start(1).unwrap();
        store.ws_record(1, &message()).unwrap();
    }
    let app = App {
        history: history.clone(),
        token: String::new(),
        pem: String::new(),
    };
    let worker_app = app.clone();
    let (entered, seen) = tokio::sync::oneshot::channel();
    let (resume, paused) = std::sync::mpsc::channel();
    let job = tokio::spawn(async move {
        read_ws(&worker_app, move |reader| {
            let filter = || storage::WsFilter {
                field_exact: None,
                socketio_exact: None,
                query: "ready",
                pointer: "/state",
                kind: "",
                format: "jsonpointer",
                direction: "",
            };
            assert_eq!(reader.ws_search_filter(1, None, filter())?["total"], 1);
            let _ = entered.send(());
            paused.recv_timeout(Duration::from_secs(10))?;
            let result = reader.ws_search_filter(1, None, filter())?;
            assert_eq!(reader.ws_summary(1)?.unwrap()["total"]["count"], 1);
            Ok(result)
        })
        .await
    });
    tokio::time::timeout(Duration::from_secs(10), seen)
        .await
        .unwrap()
        .unwrap();
    // The reader is deliberately paused inside its worker with an active WAL
    // snapshot. A real capture write must finish before that worker resumes.
    {
        let h = history
            .try_lock()
            .expect("WS scan must release the capture mutex");
        h.store.as_ref().unwrap().ws_record(1, &message()).unwrap();
    }
    resume.send(()).unwrap();
    let snapshot = job.await.unwrap().unwrap();
    assert_eq!(snapshot["total"], 1);
    assert_eq!(snapshot["matched"], 1);
    let query =
        serde_json::json!({"format":"jsonpointer","pointer":"/state","search":"ready"}).to_string();
    let latest = ws_messages(
        State(app.clone()),
        Path(1),
        Query(WsQuery {
            q: Some(query),
            before: None,
        }),
    )
    .await
    .unwrap()
    .0;
    assert_eq!(latest["total"], 2);
    assert_eq!(latest["matched"], 2);
    assert_eq!(
        ws_summary(State(app.clone()), Path(1)).await.unwrap().0["total"]["count"],
        2
    );
    assert_eq!(
        ws_cdp_related(State(app.clone()), Path((1, 1)))
            .await
            .unwrap()
            .0["supported"],
        false
    );
    assert_eq!(
        ws_messages(
            State(app.clone()),
            Path(u64::MAX),
            Query(WsQuery::default())
        )
        .await
        .unwrap_err(),
        StatusCode::BAD_REQUEST
    );
    drop(app);
    drop(history);
    std::fs::remove_file(file).unwrap();
}

#[tokio::test]
async fn proxy_streams_uploads_pairs_concurrent_requests_and_reports_failure() {
    let dir = std::env::temp_dir().join(format!("librium-test-{}", uuid::Uuid::new_v4()));
    let (authority, pem) = ca::load(&dir).unwrap();
    assert_eq!(pem, ca::load(&dir).unwrap().1, "CA must survive restart");
    let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin_addr = origin.local_addr().unwrap();
    let origin_task = tokio::spawn(async move {
        axum::serve(
            origin,
            Router::new()
                .route(
                    "/ws-denied",
                    get(|| async { (StatusCode::FORBIDDEN, "WebSocket access denied") }),
                )
                .route(
                    "/{id}",
                    post(
                        |Path(id): Path<String>, body: axum::body::Bytes| async move {
                            ([("x-test-id", id)], body)
                        },
                    ),
                ),
        )
        .await
        .unwrap();
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let history = Shared::default();
    let proxy = Proxy::builder()
        .with_listener(listener)
        .with_ca(authority)
        .with_rustls_connector(aws_lc_rs::default_provider())
        .with_http_handler(Capture {
            history: history.clone(),
            current: None,
        })
        .build()
        .unwrap();
    let proxy_task = tokio::spawn(proxy.start());
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::all(format!("http://{addr}")).unwrap())
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let mut tasks = tokio::task::JoinSet::new();
    for id in 0..8 {
        let client = client.clone();
        tasks.spawn(async move {
            let body = vec![id as u8; 70_000];
            let response = client
                .post(format!("http://{origin_addr}/{id}"))
                .body(body.clone())
                .send()
                .await
                .unwrap();
            assert_eq!(response.headers()["x-test-id"], id.to_string());
            assert_eq!(response.bytes().await.unwrap(), body);
        });
    }
    while let Some(result) = tasks.join_next().await {
        result.unwrap();
    }
    {
        let h = history.lock().unwrap();
        assert_eq!(h.rows.len(), 8);
        for row in &h.rows {
            assert_eq!(row.status, Some(200));
            assert_eq!(row.request.size, 70_000);
            assert_eq!(row.response.size, 70_000);
            assert!(row.request.complete);
            assert!(row.response.complete);
            let id = row.url.rsplit('/').next().unwrap();
            assert!(
                row.response
                    .headers
                    .iter()
                    .any(|(k, v)| k == "x-test-id" && v == id)
            );
        }
    }
    let denied = client
        .get(format!("http://{origin_addr}/ws-denied"))
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .send()
        .await
        .unwrap();
    assert_eq!(
        denied.status(),
        403,
        "A refused WebSocket must not return a fake 101"
    );
    assert_eq!(denied.text().await.unwrap(), "WebSocket access denied");
    assert_eq!(
        history.lock().unwrap().rows.back().unwrap().status,
        Some(403)
    );
    origin_task.abort();
    let _ = origin_task.await;
    let failed = client
        .get(format!("http://{origin_addr}/closed"))
        .send()
        .await
        .unwrap();
    assert_eq!(failed.status(), 502);
    assert!(history.lock().unwrap().rows.back().unwrap().error.is_some());
    proxy_task.abort();
    let _ = proxy_task.await;
    std::fs::remove_file(dir.join("ca.key")).unwrap();
    std::fs::remove_file(dir.join("ca.crt")).unwrap();
    std::fs::remove_dir(dir).unwrap();
}
