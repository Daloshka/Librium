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
                    "/headers",
                    get(|headers: axum::http::HeaderMap| async move {
                        let body = format!(
                            "{}|{}",
                            headers
                                .get("x-added")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("none"),
                            if headers.contains_key("x-gone") {
                                "present"
                            } else {
                                "absent"
                            }
                        );
                        ([("x-origin-secret", "keep-out")], body)
                    }),
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
    let ignore = Arc::new(std::sync::RwLock::new(settings::Settings::default()));
    let intercept = intercept::Shared::default();
    let recording = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let proxy = Proxy::builder()
        .with_listener(listener)
        .with_ca(authority)
        .with_rustls_connector(aws_lc_rs::default_provider())
        .with_http_handler(Capture {
            history: history.clone(),
            current: None,
            control_ports: [3000, 8080, 8081],
            settings: ignore.clone(),
            intercept: intercept.clone(),
            recording: recording.clone(),
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
            assert!(row.finished(), "a completed exchange is final");
            assert_eq!(row.status, Some(200));
            assert_eq!(row.version, "HTTP/1.1");
            assert_eq!(row.content_type, "application/octet-stream");
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
    {
        let h = history.lock().unwrap();
        let refused = h.rows.back().unwrap();
        assert_eq!(refused.status, Some(403));
        assert!(
            refused.finished(),
            "a refused upgrade must not stay in memory as streaming forever"
        );
    }
    // An ignored host is proxied but leaves no trace in the history.
    ignore.write().unwrap().ignore_hosts = vec!["127.0.0.1".into()];
    let recorded = history.lock().unwrap().rows.len();
    let quiet = client
        .post(format!("http://{origin_addr}/quiet"))
        .body("hidden")
        .send()
        .await
        .unwrap();
    assert_eq!(quiet.text().await.unwrap(), "hidden");
    assert_eq!(history.lock().unwrap().rows.len(), recorded);
    ignore.write().unwrap().ignore_hosts.clear();
    // Header rewrites change a request before it leaves the proxy; the history shows the result.
    ignore.write().unwrap().rewrites = vec![
        settings::Rewrite {
            host: "127.0.0.1".into(),
            name: "x-added".into(),
            value: "yes".into(),
            path: "*".into(),
        },
        settings::Rewrite {
            host: "*".into(),
            name: "x-gone".into(),
            value: String::new(),
            path: "*".into(),
        },
    ];
    let rewritten = client
        .get(format!("http://{origin_addr}/headers"))
        .header("x-gone", "1")
        .send()
        .await
        .unwrap();
    assert_eq!(rewritten.text().await.unwrap(), "yes|absent");
    {
        let h = history.lock().unwrap();
        let row = h.rows.back().unwrap();
        assert!(
            row.request
                .headers
                .iter()
                .any(|(name, value)| name == "x-added" && value == "yes"),
            "the recorded request carries the added header"
        );
        assert!(!row.request.headers.iter().any(|(name, _)| name == "x-gone"));
    }
    // A path pattern narrows a rewrite: one for another path leaves the request alone.
    ignore.write().unwrap().rewrites = vec![settings::Rewrite {
        host: "*".into(),
        name: "x-added".into(),
        value: "scoped".into(),
        path: "/elsewhere/*".into(),
    }];
    let untouched = client
        .get(format!("http://{origin_addr}/headers"))
        .send()
        .await
        .unwrap();
    assert_eq!(untouched.text().await.unwrap(), "none|absent");
    ignore.write().unwrap().rewrites.clear();
    // Response rewrites change what the client receives; the history shows those headers too.
    ignore.write().unwrap().response_rewrites = vec![
        settings::Rewrite {
            host: "*".into(),
            name: "access-control-allow-origin".into(),
            value: "*".into(),
            path: "*".into(),
        },
        settings::Rewrite {
            host: "127.0.0.1".into(),
            name: "x-origin-secret".into(),
            value: String::new(),
            path: "*".into(),
        },
    ];
    let rewritten = client
        .get(format!("http://{origin_addr}/headers"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        rewritten
            .headers()
            .get("access-control-allow-origin")
            .and_then(|v| v.to_str().ok()),
        Some("*")
    );
    assert!(rewritten.headers().get("x-origin-secret").is_none());
    {
        let h = history.lock().unwrap();
        let row = h.rows.back().unwrap();
        assert!(
            row.response
                .headers
                .iter()
                .any(|(name, value)| name == "access-control-allow-origin" && value == "*"),
            "the recorded response carries the added header"
        );
        assert!(
            !row.response
                .headers
                .iter()
                .any(|(name, _)| name == "x-origin-secret")
        );
    }
    ignore.write().unwrap().response_rewrites.clear();
    // A delay holds the response back; the recorded duration includes it.
    ignore.write().unwrap().delays = vec![settings::Delay {
        host: "127.0.0.1".into(),
        ms: 300,
        path: "*".into(),
    }];
    let started = std::time::Instant::now();
    client
        .get(format!("http://{origin_addr}/headers"))
        .send()
        .await
        .unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "the client waited"
    );
    assert!(
        history
            .lock()
            .unwrap()
            .rows
            .back()
            .unwrap()
            .elapsed_ms
            .is_some_and(|ms| ms >= 300)
    );
    ignore.write().unwrap().delays.clear();
    // Recording off: the request reaches the origin (with its rewrites) and leaves no row.
    recording.store(false, std::sync::atomic::Ordering::Relaxed);
    ignore.write().unwrap().rewrites = vec![settings::Rewrite {
        host: "*".into(),
        name: "x-added".into(),
        value: "still".into(),
        path: "*".into(),
    }];
    let rows_before = history.lock().unwrap().rows.len();
    let unrecorded = client
        .get(format!("http://{origin_addr}/headers"))
        .send()
        .await
        .unwrap();
    assert_eq!(unrecorded.text().await.unwrap(), "still|absent");
    assert_eq!(
        history.lock().unwrap().rows.len(),
        rows_before,
        "nothing recorded while recording is off"
    );
    ignore.write().unwrap().rewrites.clear();
    recording.store(true, std::sync::atomic::Ordering::Relaxed);
    // A mock answers without the origin and is recorded like a real exchange.
    ignore.write().unwrap().mocks = vec![settings::Mock {
        host: "127.0.0.1".into(),
        path: "/mocked/*".into(),
        method: "GET".into(),
        status: 418,
        content_type: "application/json".into(),
        body: r#"{"mock":true}"#.into(),
        enabled: true,
    }];
    let mocked = client
        .get(format!("http://{origin_addr}/mocked/thing?x=1"))
        .send()
        .await
        .unwrap();
    assert_eq!(mocked.status(), 418);
    assert_eq!(
        mocked
            .headers()
            .get("x-librium-mock")
            .and_then(|v| v.to_str().ok()),
        Some("1")
    );
    assert_eq!(mocked.text().await.unwrap(), r#"{"mock":true}"#);
    {
        let h = history.lock().unwrap();
        let row = h.rows.back().unwrap();
        assert_eq!(row.status, Some(418));
        assert!(row.mock && row.summary().mock);
        assert_eq!(row.content_type, "application/json");
        assert_eq!(row.url, format!("http://{origin_addr}/mocked/thing?x=1"));
        let view = row.response.view_within(capture::PREVIEW_LIMIT);
        assert_eq!(view.text, r#"{"mock":true}"#);
        assert!(view.complete);
    }
    // An ignored host is still mocked; the mock just leaves no row.
    ignore.write().unwrap().ignore_hosts = vec!["127.0.0.1".into()];
    let rows_before = history.lock().unwrap().rows.len();
    let ignored_mock = client
        .get(format!("http://{origin_addr}/mocked/ignored"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        ignored_mock.status(),
        418,
        "the mock answers for an ignored host"
    );
    assert_eq!(
        history.lock().unwrap().rows.len(),
        rows_before,
        "but nothing is recorded for it"
    );
    ignore.write().unwrap().ignore_hosts.clear();
    // Response rewrites shape mocked answers too.
    ignore.write().unwrap().response_rewrites = vec![settings::Rewrite {
        host: "*".into(),
        name: "x-mocked-too".into(),
        value: "yes".into(),
        path: "*".into(),
    }];
    let rewritten_mock = client
        .get(format!("http://{origin_addr}/mocked/again"))
        .send()
        .await
        .unwrap();
    assert_eq!(
        rewritten_mock
            .headers()
            .get("x-mocked-too")
            .and_then(|v| v.to_str().ok()),
        Some("yes")
    );
    ignore.write().unwrap().response_rewrites.clear();
    // A mock for uploads records what the app sent.
    ignore.write().unwrap().mocks.push(settings::Mock {
        host: "*".into(),
        path: "/mocked/upload".into(),
        method: "POST".into(),
        status: 202,
        content_type: "text/plain".into(),
        body: "queued".into(),
        enabled: true,
    });
    let uploaded = client
        .post(format!("http://{origin_addr}/mocked/upload"))
        .body("payload=1")
        .send()
        .await
        .unwrap();
    assert_eq!(uploaded.status(), 202);
    {
        let h = history.lock().unwrap();
        let row = h.rows.back().unwrap();
        let view = row.request.view_within(capture::PREVIEW_LIMIT);
        assert_eq!(view.text, "payload=1", "the upload is recorded");
        assert!(view.complete);
    }
    // A slow-network delay holds a mock back as well.
    ignore.write().unwrap().delays = vec![settings::Delay {
        host: "127.0.0.1".into(),
        ms: 200,
        path: "*".into(),
    }];
    let started = std::time::Instant::now();
    client
        .get(format!("http://{origin_addr}/mocked/slow"))
        .send()
        .await
        .unwrap();
    assert!(
        started.elapsed() >= Duration::from_millis(200),
        "the mock waited"
    );
    assert!(
        history
            .lock()
            .unwrap()
            .rows
            .back()
            .unwrap()
            .elapsed_ms
            .is_some_and(|ms| ms >= 200)
    );
    ignore.write().unwrap().delays.clear();
    let not_mocked = client
        .post(format!("http://{origin_addr}/mocked/thing"))
        .body("x")
        .send()
        .await
        .unwrap();
    assert!(
        not_mocked.headers().get("x-librium-mock").is_none(),
        "another method reaches the origin (which has no such route: {})",
        not_mocked.status()
    );
    ignore.write().unwrap().mocks.clear();
    // Intercept: a held request is edited and forwarded, the next one dropped; off, all passes.
    intercept
        .lock()
        .unwrap()
        .set_rules(intercept::Rules {
            enabled: true,
            hosts: vec!["127.0.0.1".into()],
            responses: false,
            ..Default::default()
        })
        .unwrap();
    let held_client = client.clone();
    let held = tokio::spawn(async move {
        held_client
            .post(format!("http://{origin_addr}/held"))
            .body("original")
            .send()
            .await
            .unwrap()
    });
    let view = loop {
        let state = intercept.lock().unwrap().view();
        if let Some(first) = state["held"].as_array().unwrap().first() {
            break first.clone();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    assert_eq!(view["method"], "POST");
    assert_eq!(view["text"], "original");
    let edit = intercept::Decision {
        action: "forward".into(),
        text: Some("edited".into()),
        headers: Some(vec![
            ("x-int".into(), "1".into()),
            ("content-type".into(), "text/plain".into()),
        ]),
        ..Default::default()
    }
    .validate()
    .unwrap();
    let id = view["id"].as_u64().unwrap();
    assert!(intercept.lock().unwrap().decide(id, edit));
    let response = held.await.unwrap();
    assert_eq!(response.headers().get("x-test-id").unwrap(), "held");
    assert_eq!(
        response.text().await.unwrap(),
        "edited",
        "the origin got the edited body"
    );
    {
        let h = history.lock().unwrap();
        let row = h.rows.back().unwrap();
        assert!(
            row.request
                .headers
                .iter()
                .any(|(name, value)| name == "x-int" && value == "1"),
            "the history shows the request as it was sent"
        );
        assert_eq!(row.request.size, "edited".len());
    }
    assert!(
        !intercept.lock().unwrap().decide(
            id,
            intercept::Decision::default().validate().unwrap_or(
                intercept::Decision {
                    action: "forward".into(),
                    ..Default::default()
                }
                .validate()
                .unwrap()
            )
        ),
        "a decided request is no longer held"
    );
    let dropped_client = client.clone();
    let dropped = tokio::spawn(async move {
        dropped_client
            .get(format!("http://{origin_addr}/dropped"))
            .send()
            .await
            .unwrap()
    });
    let id = loop {
        let state = intercept.lock().unwrap().view();
        if let Some(first) = state["held"].as_array().unwrap().first() {
            break first["id"].as_u64().unwrap();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let drop = intercept::Decision {
        action: "drop".into(),
        ..Default::default()
    }
    .validate()
    .unwrap();
    assert!(intercept.lock().unwrap().decide(id, drop));
    let response = dropped.await.unwrap();
    assert_eq!(response.status(), 502);
    assert_eq!(
        history
            .lock()
            .unwrap()
            .rows
            .back()
            .unwrap()
            .error
            .as_deref(),
        Some(intercept::DROPPED)
    );
    // Responses are held too when asked: status and body edited, the next one dropped.
    intercept
        .lock()
        .unwrap()
        .set_rules(intercept::Rules {
            enabled: true,
            hosts: vec!["127.0.0.1".into()],
            responses: true,
            ..Default::default()
        })
        .unwrap();
    let wait_held = |shared: intercept::Shared| async move {
        loop {
            let view = shared.lock().unwrap().view();
            if let Some(first) = view["held"].as_array().unwrap().first() {
                break first.clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    let forward = || {
        intercept::Decision {
            action: "forward".into(),
            ..Default::default()
        }
        .validate()
        .unwrap()
    };
    let both_client = client.clone();
    let both = tokio::spawn(async move {
        both_client
            .post(format!("http://{origin_addr}/both"))
            .body("hello")
            .send()
            .await
            .unwrap()
    });
    let request_view = wait_held(intercept.clone()).await;
    assert_eq!(request_view["kind"], "request");
    intercept
        .lock()
        .unwrap()
        .decide(request_view["id"].as_u64().unwrap(), forward());
    let response_view = wait_held(intercept.clone()).await;
    assert_eq!(response_view["kind"], "response");
    assert_eq!(response_view["status"], 200);
    assert_eq!(response_view["text"], "hello");
    assert_eq!(
        response_view["url"].as_str().unwrap(),
        format!("http://{origin_addr}/both")
    );
    let edit = intercept::Decision {
        action: "forward".into(),
        status: Some(201),
        text: Some("changed".into()),
        ..Default::default()
    }
    .validate()
    .unwrap();
    intercept
        .lock()
        .unwrap()
        .decide(response_view["id"].as_u64().unwrap(), edit);
    let response = both.await.unwrap();
    assert_eq!(response.status(), 201, "the client got the edited status");
    assert_eq!(response.text().await.unwrap(), "changed");
    {
        let h = history.lock().unwrap();
        let row = h.rows.back().unwrap();
        assert_eq!(
            row.status,
            Some(201),
            "the history shows what the client got"
        );
    }
    let gone_client = client.clone();
    let gone = tokio::spawn(async move {
        gone_client
            .post(format!("http://{origin_addr}/gone"))
            .body("x")
            .send()
            .await
            .unwrap()
    });
    let request_view = wait_held(intercept.clone()).await;
    intercept
        .lock()
        .unwrap()
        .decide(request_view["id"].as_u64().unwrap(), forward());
    let response_view = wait_held(intercept.clone()).await;
    intercept.lock().unwrap().decide(
        response_view["id"].as_u64().unwrap(),
        intercept::Decision {
            action: "drop".into(),
            ..Default::default()
        }
        .validate()
        .unwrap(),
    );
    let response = gone.await.unwrap();
    assert_eq!(response.status(), 502);
    assert_eq!(
        history
            .lock()
            .unwrap()
            .rows
            .back()
            .unwrap()
            .error
            .as_deref(),
        Some(intercept::DROPPED)
    );
    assert!(
        history.lock().unwrap().rows.back().unwrap().finished(),
        "a dropped response ends the exchange"
    );
    intercept
        .lock()
        .unwrap()
        .set_rules(intercept::Rules::default())
        .unwrap();
    let free = client
        .post(format!("http://{origin_addr}/free"))
        .body("free")
        .send()
        .await
        .unwrap();
    assert_eq!(free.text().await.unwrap(), "free", "off: nothing is held");
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

async fn json(request: reqwest::RequestBuilder) -> serde_json::Value {
    serde_json::from_str(&request.send().await.unwrap().text().await.unwrap()).unwrap()
}
#[tokio::test]
async fn api_guards_requests_and_serves_state_pages_details_and_shutdown() {
    let dir = std::env::temp_dir().join(format!("librium-api-{}", uuid::Uuid::new_v4()));
    let (_, pem) = ca::load(&dir).unwrap();
    let history_path = dir.join("history.sqlite3");
    let history = Arc::new(Mutex::new(capture::History::open(&history_path).unwrap()));
    let reader = Arc::new(Mutex::new(
        storage::Store::open_reader(&history_path).unwrap(),
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let stop = Arc::new(tokio::sync::Notify::new());
    let app = App {
        history: history.clone(),
        reader,
        stop: stop.clone(),
        history_path: history_path.clone(),
        settings: Arc::new(std::sync::RwLock::new(settings::Settings::default())),
        intercept: intercept::Shared::default(),
        recording: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        data_dir: dir.clone(),
        token: "test-token".into(),
        pem,
        hosts: [format!("127.0.0.1:{port}"), format!("localhost:{port}")],
        info: serde_json::json!({"version": "test"}),
    };
    let server = tokio::spawn(axum::serve(listener, router(app)).into_future());
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let api = |path: &str| {
        client
            .get(format!("{base}{path}"))
            .header("x-librium-token", "test-token")
    };
    assert_eq!(
        client
            .get(format!("{base}/api/state"))
            .send()
            .await
            .unwrap()
            .status(),
        401,
        "API calls need the token"
    );
    assert_eq!(
        api("/api/state")
            .header("host", "attacker.test")
            .send()
            .await
            .unwrap()
            .status(),
        403,
        "a foreign Host header is refused"
    );
    let html = client.get(format!("{base}/")).send().await.unwrap();
    assert!(
        html.headers()["content-security-policy"]
            .to_str()
            .unwrap()
            .contains("frame-ancestors 'none'")
    );
    assert!(
        html.text()
            .await
            .unwrap()
            .contains("const token='test-token'")
    );
    let state: serde_json::Value = json(api("/api/state")).await;
    assert_eq!(state["revision"], 0);
    assert_eq!(state["error"], serde_json::Value::Null);
    let saved = client
        .put(format!("{base}/api/settings"))
        .header("x-librium-token", "test-token")
        .header("content-type", "application/json")
        .body(r#"{"ignore_hosts":[" *.Telemetry.Example ","cdn.test"]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), 204);
    let settings: serde_json::Value = json(api("/api/settings")).await;
    assert_eq!(
        settings["ignore_hosts"],
        serde_json::json!(["*.telemetry.example", "cdn.test"])
    );
    assert!(
        dir.join("settings.json").exists(),
        "settings persist next to the history"
    );
    // Rewrites are normalized too, and a partial update leaves the other setting alone.
    assert_eq!(
        client
            .put(format!("{base}/api/settings"))
            .header("x-librium-token", "test-token")
            .header("content-type", "application/json")
            .body(r#"{"rewrites":[{"host":" API.Example ","name":"X-Debug","value":" 1 "}]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    let settings: serde_json::Value = json(api("/api/settings")).await;
    assert_eq!(
        settings["rewrites"],
        serde_json::json!([{"host":"api.example","name":"x-debug","value":"1","path":"*"}])
    );
    assert_eq!(
        settings["ignore_hosts"],
        serde_json::json!(["*.telemetry.example", "cdn.test"]),
        "untouched by a partial update"
    );
    assert_eq!(
        client
            .put(format!("{base}/api/settings"))
            .header("x-librium-token", "test-token")
            .header("content-type", "application/json")
            .body(r#"{"response_rewrites":[{"host":"*","name":"Content-Security-Policy","value":""}]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    let settings: serde_json::Value = json(api("/api/settings")).await;
    assert_eq!(
        settings["response_rewrites"],
        serde_json::json!([{"host":"*","name":"content-security-policy","value":"","path":"*"}])
    );
    assert_eq!(
        settings["rewrites"],
        serde_json::json!([{"host":"api.example","name":"x-debug","value":"1","path":"*"}]),
        "request rewrites survive a response-rewrite update"
    );
    for (body, status) in [
        (r#"{"delays":[{"host":" Slow.Example ","ms":1500}]}"#, 204),
        (r#"{"delays":[{"host":"*","ms":0}]}"#, 400),
        (r#"{"delays":[{"host":"*","ms":600000}]}"#, 400),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/settings"))
                .header("x-librium-token", "test-token")
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .unwrap()
                .status(),
            status,
            "{body}"
        );
    }
    let settings: serde_json::Value = json(api("/api/settings")).await;
    assert_eq!(
        settings["delays"],
        serde_json::json!([{"host":"slow.example","ms":1500,"path":"*"}])
    );
    for (body, status) in [
        (
            r#"{"mocks":[{"host":" Mock.Example ","path":"","method":"get","status":200,"content_type":"","body":"ok"}]}"#,
            204,
        ),
        (r#"{"mocks":[{"host":"*","path":"/","status":42}]}"#, 400),
        (
            r#"{"mocks":[{"host":"*","path":"nope","status":200}]}"#,
            400,
        ),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/settings"))
                .header("x-librium-token", "test-token")
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .unwrap()
                .status(),
            status,
            "{body}"
        );
    }
    let state: serde_json::Value = json(api("/api/state")).await;
    assert_eq!(state["recording"], true);
    for (body, expected) in [
        (r#"{"enabled":false}"#, false),
        (r#"{"enabled":true}"#, true),
    ] {
        assert_eq!(
            client
                .put(format!("{base}/api/recording"))
                .header("x-librium-token", "test-token")
                .header("content-type", "application/json")
                .body(body)
                .send()
                .await
                .unwrap()
                .status(),
            204
        );
        let now: serde_json::Value = json(api("/api/recording")).await;
        assert_eq!(now["enabled"], expected);
    }
    assert_eq!(state["tweaks"]["mocks"], 1, "{}", state["tweaks"]);
    assert_eq!(state["tweaks"]["delays"], 1);
    assert_eq!(
        state["tweaks"]["rewrites"], 2,
        "request + response rewrites"
    );
    assert_eq!(state["tweaks"]["ignored"], 2);
    let settings: serde_json::Value = json(api("/api/settings")).await;
    assert_eq!(
        settings["mocks"],
        serde_json::json!([{"host":"mock.example","path":"*","method":"GET","status":200,"content_type":"text/plain; charset=utf-8","body":"ok","enabled":true}])
    );
    assert_eq!(
        client
            .put(format!("{base}/api/settings"))
            .header("x-librium-token", "test-token")
            .header("content-type", "application/json")
            .body(r#"{"rewrites":[{"host":"*","name":"bad name","value":"1"}]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        client
            .put(format!("{base}/api/settings"))
            .header("x-librium-token", "test-token")
            .header("content-type", "application/json")
            .body(r#"{"ignore_hosts":["no spaces allowed"]}"#)
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    // Intercept rules are validated, a decision for nothing held is 404, the state counts held ones.
    let put_intercept = |body: &'static str| {
        client
            .put(format!("{base}/api/intercept"))
            .header("x-librium-token", "test-token")
            .header("content-type", "application/json")
            .body(body)
            .send()
    };
    assert_eq!(
        put_intercept(r#"{"enabled":true,"hosts":["bad host"]}"#)
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        put_intercept(r#"{"enabled":true,"methods":["ge t"]}"#)
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(
        put_intercept(
            r#"{"enabled":true,"hosts":[" API.Example "],"responses":true,"methods":["post"," Put "],"path":" /API/ "}"#
        )
        .await
        .unwrap()
        .status(),
        204
    );
    let intercepting: serde_json::Value = json(api("/api/intercept")).await;
    assert_eq!(intercepting["enabled"], true);
    assert_eq!(intercepting["responses"], true);
    assert_eq!(intercepting["hosts"], serde_json::json!(["api.example"]));
    assert_eq!(intercepting["methods"], serde_json::json!(["POST", "PUT"]));
    assert_eq!(intercepting["path"], "/api/");
    assert_eq!(intercepting["held"].as_array().unwrap().len(), 0);
    let decide = |body: &'static str| {
        client
            .post(format!("{base}/api/intercept/7"))
            .header("x-librium-token", "test-token")
            .header("content-type", "application/json")
            .body(body)
            .send()
    };
    assert_eq!(
        decide(r#"{"action":"forward"}"#).await.unwrap().status(),
        404
    );
    assert_eq!(
        decide(r#"{"action":"explode"}"#).await.unwrap().status(),
        400
    );
    assert_eq!(
        decide(r#"{"action":"forward","status":42}"#)
            .await
            .unwrap()
            .status(),
        400,
        "an impossible status is refused before anything waits on it"
    );
    let state: serde_json::Value = json(api("/api/state")).await;
    assert_eq!(state["held"], 0);
    assert_eq!(
        put_intercept(r#"{"enabled":false}"#)
            .await
            .unwrap()
            .status(),
        204
    );
    assert!(state["disk"].as_u64().unwrap() > 0, "{state}");
    let row = serde_json::json!({
        "summary":{"id":1,"time":1,"method":"GET","url":"https://example.test/a.json","version":"HTTP/2","content_type":"application/json","status":200,"elapsed_ms":3,"size":2,"error":null},
        "request":{"headers":[],"text":"","base64":"","size":0,"complete":true,"truncated":false},
        "response":{"headers":[["content-type","application/json"]],"text":"{}","base64":"e30=","size":2,"complete":true,"truncated":false}
    });
    history
        .lock()
        .unwrap()
        .restore_json(&serde_json::json!([row]).to_string())
        .unwrap();
    history.lock().unwrap().flush().unwrap();
    let state: serde_json::Value = json(api("/api/state")).await;
    assert_eq!(
        state["revision"], 1,
        "a flush that wrote something is a new revision"
    );
    let page: serde_json::Value =
        json(api("/api/traffic-page?q=%7B%22query%22%3A%22json%22%7D")).await;
    assert_eq!(page["total"], 1);
    assert_eq!(page["rows"][0]["id"], 1);
    assert_eq!(page["rows"][0]["content_type"], "application/json");
    assert_eq!(
        api("/api/traffic-page?q=%7B%22sort%22%3A%22nope%22%7D")
            .send()
            .await
            .unwrap()
            .status(),
        500,
        "an unknown sort field is rejected, not interpolated"
    );
    {
        // A row still streaming in memory is served as its preview only; once it ends, in full.
        let mut h = history.lock().unwrap();
        let big = vec![b'x'; 3 * capture::PREVIEW_LIMIT];
        let streaming = capture::test_exchange(9, &big);
        h.rows.push_back(streaming);
    }
    let partial: serde_json::Value = json(api("/api/traffic/9")).await;
    assert_eq!(partial["response"]["complete"], false);
    assert_eq!(
        partial["response"]["base64"].as_str().unwrap().len(),
        capture::PREVIEW_LIMIT.div_ceil(3) * 4,
        "a streaming body is previewed, not shipped whole"
    );
    history.lock().unwrap().row_mut(9).unwrap().finish();
    let full: serde_json::Value = json(api("/api/traffic/9")).await;
    assert_eq!(full["response"]["complete"], true);
    assert_eq!(
        full["response"]["base64"].as_str().unwrap().len(),
        (3 * capture::PREVIEW_LIMIT).div_ceil(3) * 4
    );
    let detail: serde_json::Value = json(api("/api/traffic/1")).await;
    assert_eq!(detail["summary"]["version"], "HTTP/2");
    assert_eq!(detail["response"]["base64"], "e30=");
    assert_eq!(api("/api/traffic/2").send().await.unwrap().status(), 404);
    let ws: serde_json::Value = json(api("/api/traffic/1/ws")).await;
    assert_eq!(ws["state"], "not_recorded");
    assert_eq!(
        client
            .delete(format!("{base}/api/traffic/9"))
            .header("x-librium-token", "test-token")
            .send()
            .await
            .unwrap()
            .status(),
        204,
        "one exchange can be deleted"
    );
    assert_eq!(api("/api/traffic/9").send().await.unwrap().status(), 404);
    assert_eq!(
        client
            .delete(format!("{base}/api/traffic/9"))
            .header("x-librium-token", "test-token")
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    let page: serde_json::Value = json(api("/api/traffic-page?q=%7B%7D")).await;
    let stats: serde_json::Value = json(api("/api/traffic-stats?q=%7B%7D")).await;
    assert_eq!(
        stats["matched"], page["total"],
        "the summary counts what the page counts"
    );
    assert!(!stats["hosts"].as_array().unwrap().is_empty());
    assert_eq!(
        api("/api/traffic-stats?q=nope")
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert_eq!(page["total"], 1, "the other exchange stays");
    // Imported exchanges get fresh ids after the newest one and are final.
    let imported: serde_json::Value = serde_json::from_str(
        &client
            .post(format!("{base}/api/import"))
            .header("x-librium-token", "test-token")
            .header("content-type", "application/json")
            .body(serde_json::json!([{
                "summary":{"id":1,"time":5,"method":"POST","url":"https://imported.test/x","status":201,"elapsed_ms":7,"size":2,"error":null},
                "request":{"headers":[["content-type","text/plain"]],"text":"hi","base64":"aGk=","size":2,"complete":true,"truncated":false},
                "response":{"headers":[],"text":"ok","base64":"b2s=","size":2,"complete":true,"truncated":false}
            },{
                "summary":{"id":1,"time":5,"method":"GET","url":"wss://imported.test/socket","status":101,"elapsed_ms":null,"size":0,"error":null},
                "request":{"headers":[],"text":"","base64":"","size":0,"complete":true,"truncated":false},
                "response":{"headers":[],"text":"","base64":"","size":0,"complete":true,"truncated":false},
                "frames":[{"time":6,"direction":"sent","kind":"TEXT","base64":"aGVsbG8="},{"time":7,"direction":"received","kind":"BINARY","base64":"AQID"}]
            }]).to_string())
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(imported["imported"], 2);
    let page: serde_json::Value = json(api(
        "/api/traffic-page?q=%7B%22query%22%3A%22imported.test%22%7D",
    ))
    .await;
    assert_eq!(page["matched"], 2);
    let rows = page["rows"].as_array().unwrap();
    let http = rows
        .iter()
        .find(|r| r["url"] == "https://imported.test/x")
        .unwrap();
    let socket = rows
        .iter()
        .find(|r| r["url"] == "wss://imported.test/socket")
        .unwrap();
    let fresh = http["id"].as_u64().unwrap();
    assert!(
        fresh > 9,
        "a fresh id above everything captured so far: {fresh}"
    );
    assert_eq!(http["finished"], true);
    let detail: serde_json::Value = json(api(&format!("/api/traffic/{fresh}"))).await;
    assert_eq!(detail["request"]["text"], "hi");
    // A star and a note stick to the exchange and can be searched for.
    let patch = |id: u64, body: &'static str| {
        client
            .patch(format!("{base}/api/traffic/{id}"))
            .header("x-librium-token", "test-token")
            .header("content-type", "application/json")
            .body(body)
            .send()
    };
    assert_eq!(
        patch(fresh, r#"{"starred":true,"note":"todo: check"}"#)
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(
        patch(987654, r#"{"starred":true}"#).await.unwrap().status(),
        404
    );
    let marked: serde_json::Value = json(api(
        "/api/traffic-page?q=%7B%22rules%22%3A%5B%7B%22field%22%3A%22starred%22%2C%22op%22%3A%22eq%22%2C%22value%22%3A%221%22%7D%5D%7D",
    ))
    .await;
    assert_eq!(marked["matched"], 1);
    assert_eq!(marked["rows"][0]["id"], fresh);
    assert_eq!(marked["rows"][0]["note"], "todo: check");
    let detail: serde_json::Value = json(api(&format!("/api/traffic/{fresh}"))).await;
    assert_eq!(detail["summary"]["starred"], true);
    // The socket's frames were queued and written like a captured session's.
    let ws: serde_json::Value = json(api(&format!("/api/traffic/{}/ws", socket["id"]))).await;
    assert_eq!(ws["state"], "closed");
    assert_eq!(ws["total"], 2);
    assert_eq!(ws["messages"][0]["direction"], "sent");
    assert_eq!(ws["messages"][0]["text"], "hello");
    assert_eq!(ws["messages"][1]["kind"], "BINARY");
    assert_eq!(ws["messages"][1]["base64"], "AQID");
    assert_eq!(
        client
            .delete(format!("{base}/api/traffic/{}", socket["id"]))
            .header("x-librium-token", "test-token")
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(
        client
            .delete(format!("{base}/api/traffic/{fresh}"))
            .header("x-librium-token", "test-token")
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    let gone: serde_json::Value = serde_json::from_str(
        &client
            .delete(format!(
                "{base}/api/traffic-page?q=%7B%22query%22%3A%22nothing-here%22%7D"
            ))
            .header("x-librium-token", "test-token")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        gone["deleted"], 0,
        "a filter that matches nothing deletes nothing"
    );
    let gone: serde_json::Value = serde_json::from_str(
        &client
            .delete(format!(
                "{base}/api/traffic-page?q=%7B%22query%22%3A%22json%22%7D"
            ))
            .header("x-librium-token", "test-token")
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(gone["deleted"], 1);
    let page: serde_json::Value = json(api("/api/traffic-page?q=%7B%7D")).await;
    assert_eq!(page["total"], 0);
    assert_eq!(
        client
            .delete(format!("{base}/api/traffic"))
            .header("x-librium-token", "test-token")
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    let page: serde_json::Value = json(api("/api/traffic-page?q=%7B%7D")).await;
    assert_eq!(page["total"], 0);
    assert_eq!(
        client
            .post(format!("{base}/api/shutdown"))
            .header("x-librium-token", "test-token")
            .send()
            .await
            .unwrap()
            .status(),
        204
    );
    assert!(
        tokio::time::timeout(Duration::from_secs(1), stop.notified())
            .await
            .is_ok(),
        "the shutdown request must wake the main loop"
    );
    server.abort();
    let _ = server.await;
    history.lock().unwrap().close().unwrap();
    drop(history);
    std::fs::remove_dir_all(dir).unwrap();
}
