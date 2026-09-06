use super::*;
use axum::routing::post;
use std::time::Duration;

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
