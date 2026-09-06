mod ca;
mod capture;
mod storage;
mod websocket;

#[cfg(test)]
mod tests;

use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{StatusCode, header},
    middleware::{self, Next},
    response::{Html, IntoResponse, Response},
    routing::get,
};
use capture::{Capture, Shared, Summary};
use hudsucker::{Proxy, rustls::crypto::aws_lc_rs};
use serde::Deserialize;
use std::{net::SocketAddr, path::PathBuf};

#[derive(Clone)]
struct App {
    history: Shared,
    token: String,
    pem: String,
}

async fn protect(State(app): State<App>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if host != "127.0.0.1:3000" && host != "localhost:3000" {
        return StatusCode::FORBIDDEN.into_response();
    }
    if req.uri().path().starts_with("/api/")
        && req
            .headers()
            .get("x-librium-token")
            .and_then(|h| h.to_str().ok())
            != Some(app.token.as_str())
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut response = next.run(req).await;
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert("x-frame-options", "DENY".parse().unwrap());
    response.headers_mut().insert("content-security-policy", "default-src 'self'; img-src 'self' blob: data:; media-src blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'".parse().unwrap());
    response
}
async fn index(State(app): State<App>) -> Html<String> {
    Html(include_str!("../ui/index.html").replace("__TOKEN__", &app.token))
}
fn storage_error(error: impl std::fmt::Display) -> StatusCode {
    eprintln!("Librium history storage: {error}");
    StatusCode::INTERNAL_SERVER_ERROR
}
async fn list(State(app): State<App>) -> Result<Json<Vec<Summary>>, StatusCode> {
    let mut history = app.history.lock().unwrap();
    history.flush().map_err(storage_error)?;
    if let Some(store) = &history.store {
        return Ok(Json(
            store
                .search(&storage::Search::default())
                .map_err(storage_error)?
                .rows,
        ));
    }
    Ok(Json(
        history.rows.iter().rev().map(|r| r.summary()).collect(),
    ))
}
#[derive(Deserialize)]
struct PageQuery {
    q: String,
}
async fn page(
    State(app): State<App>,
    Query(query): Query<PageQuery>,
) -> Result<Json<storage::Page>, StatusCode> {
    let search: storage::Search =
        serde_json::from_str(&query.q).map_err(|_| StatusCode::BAD_REQUEST)?;
    let mut history = app.history.lock().unwrap();
    history.flush().map_err(storage_error)?;
    let store = history
        .store
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(Json(store.search(&search).map_err(storage_error)?))
}
async fn detail(
    State(app): State<App>,
    Path(id): Path<u64>,
) -> Result<Json<capture::SavedExchange>, StatusCode> {
    let history = app.history.lock().unwrap();
    if let Some(row) = history.rows.iter().find(|r| r.id == id) {
        return Ok(Json(row.saved()));
    }
    history
        .store
        .as_ref()
        .ok_or(StatusCode::NOT_FOUND)?
        .detail(id)
        .map_err(storage_error)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
#[derive(Default, Deserialize)]
struct WsQuery {
    before: Option<i64>,
}
async fn ws_messages(
    State(app): State<App>,
    Path(id): Path<u64>,
    Query(query): Query<WsQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let h = app.history.lock().unwrap();
    Ok(Json(
        h.store
            .as_ref()
            .ok_or(StatusCode::SERVICE_UNAVAILABLE)?
            .ws_page(id, query.before)
            .map_err(storage_error)?,
    ))
}
async fn clear(State(app): State<App>) -> Result<StatusCode, StatusCode> {
    let mut history = app.history.lock().unwrap();
    history.flush().map_err(storage_error)?;
    history.clear().map_err(storage_error)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn flush(State(app): State<App>) -> Result<StatusCode, StatusCode> {
    app.history.lock().unwrap().flush().map_err(storage_error)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn certificate(State(app): State<App>) -> impl IntoResponse {
    (
        [
            (header::CONTENT_TYPE, "application/x-pem-file"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=librium-ca.crt",
            ),
        ],
        app.pem,
    )
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = aws_lc_rs::default_provider().install_default();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();
    let dir = std::env::var_os("LIBRIUM_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(".local"))
                .join("Librium")
        });
    let (authority, pem) = ca::load(&dir)?;
    let history = std::sync::Arc::new(std::sync::Mutex::new(capture::History::open(
        &dir.join("history.sqlite3"),
    )?));
    if let Some(snapshot) = std::env::var_os("LIBRIUM_RESTORE") {
        let json = std::fs::read_to_string(snapshot).context("Cannot read history snapshot")?;
        history
            .lock()
            .unwrap()
            .restore_json(&json)
            .context("Cannot restore history snapshot")?;
    }
    history.lock().unwrap().flush()?;
    let writer_history = history.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let h = writer_history.clone();
            let _ = tokio::task::spawn_blocking(move || {
                if let Err(error) = h.lock().unwrap().flush() {
                    eprintln!("Librium history storage: {error}");
                }
            })
            .await;
        }
    });
    let app = App {
        history: history.clone(),
        token: uuid::Uuid::new_v4().to_string(),
        pem,
    };
    let router = Router::new()
        .route("/", get(index))
        .route(
            "/style.css",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
                    include_str!("../ui/style.css"),
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../ui/app.js"),
                )
            }),
        )
        .route("/api/traffic", get(list).delete(clear))
        .route("/api/traffic-page", get(page))
        .route("/api/storage-flush", axum::routing::post(flush))
        .route(
            "/api/info",
            get(|| async {
                Json(serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"phone_lan":true,"persistent_history":true}))
            }),
        )
        .route(
            "/filters.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../ui/filters.js"),
                )
            }),
        )
        .route(
            "/mobile.js",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/javascript; charset=utf-8")],
                    include_str!("../ui/mobile.js"),
                )
            }),
        )
        .route("/api/traffic/{id}", get(detail))
        .route("/api/traffic/{id}/ws",get(ws_messages))
        .route("/api/ca", get(certificate))
        .layer(middleware::from_fn_with_state(app.clone(), protect))
        .with_state(app);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:3000")
        .await
        .context("UI port 3000 is busy")?;
    let proxy = Proxy::builder()
        .with_addr(SocketAddr::from(([127, 0, 0, 1], 8080)))
        .with_ca(authority)
        .with_rustls_connector(aws_lc_rs::default_provider())
        .with_http_handler(Capture {
            history: history.clone(),
            current: None,
        })
        .build()
        .context("Cannot build proxy")?;
    println!(
        "Librium\n  UI:    http://127.0.0.1:3000\n  Proxy: 127.0.0.1:8080\n  CA:    {}\nCtrl+C to stop",
        dir.join("ca.crt").display()
    );
    tokio::select! {
        result = proxy.start() => result.context("Proxy stopped")?,
        result = axum::serve(listener, router) => result.context("UI stopped")?,
        result = tokio::signal::ctrl_c() => result?,
    }
    writer.abort();
    history.lock().unwrap().flush()?;
    Ok(())
}
