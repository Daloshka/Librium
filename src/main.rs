mod ca;
mod capture;
mod cdp_related;
mod external;
mod inflate;
mod json_object;
mod json_pointer;
mod jsonrpc;
mod msgpack;
mod protobuf;
mod socketio;
mod storage;
mod websocket;
mod ws_fields;
mod ws_profile;
mod ws_search;
mod ws_transport;

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

// Shared limit for expensive WS reads. The permit lives in the blocking worker,
// so disconnecting a client cannot start unbounded overlapping scans.
static WS_READERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
async fn read_ws<T, F>(app: &App, read: F) -> Result<T, StatusCode>
where
    T: Send + 'static,
    F: FnOnce(storage::Store) -> anyhow::Result<T> + Send + 'static,
{
    let permit = WS_READERS
        .acquire()
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    let reader = app
        .history
        .lock()
        .unwrap()
        .store
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?
        .read_snapshot()
        .map_err(storage_error)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        read(reader)
    })
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .map_err(storage_error)
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
    if !["", "client", "server", "unknown"].contains(&search.ws_role.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if search
        .capture_context
        .as_deref()
        .is_some_and(|value| !capture::valid_context(value))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
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
async fn capture_contexts(
    State(app): State<App>,
    Query(query): Query<PageQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let query: storage::ContextsQuery =
        serde_json::from_str(&query.q).map_err(|_| StatusCode::BAD_REQUEST)?;
    if !query.valid() {
        return Err(StatusCode::BAD_REQUEST);
    }
    read_ws(&app, move |reader| reader.capture_contexts(&query))
        .await
        .map(Json)
}
async fn ws_archive_search(
    State(app): State<App>,
    Json(query): Json<storage::ArchiveWsQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let prepared = query.prepare().map_err(|_| StatusCode::BAD_REQUEST)?;
    read_ws(&app, move |reader| reader.ws_archive_search(&prepared))
        .await
        .map(Json)
}
#[derive(Default, Deserialize)]
struct WsQuery {
    before: Option<i64>,
    q: Option<String>,
}
#[derive(Default, Deserialize)]
#[serde(default)]
struct WsSearch {
    before: Option<i64>,
    search: String,
    kind: String,
    format: String,
    direction: String,
    pointer: String,
    exact: Option<json_pointer::ScalarFilter>,
    socketio_exact: Option<socketio::EventKey>,
    field_exact: Option<ws_fields::FieldExact>,
}
async fn ws_messages(
    State(app): State<App>,
    Path(id): Path<u64>,
    Query(query): Query<WsQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let search: WsSearch = match query.q {
        Some(q) => serde_json::from_str(&q).map_err(|_| StatusCode::BAD_REQUEST)?,
        None => WsSearch {
            before: query.before,
            ..Default::default()
        },
    };
    ws_search_response(app, id, search).await
}
async fn ws_search_post(
    State(app): State<App>,
    Path(id): Path<u64>,
    Json(search): Json<WsSearch>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    ws_search_response(app, id, search).await
}
async fn ws_search_response(
    app: App,
    id: u64,
    search: WsSearch,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if (search.format == "protocol_field") != search.field_exact.is_some()
        || search.field_exact.as_ref().is_some_and(|field| {
            field.prepare().is_none()
                || !search.search.is_empty()
                || search.exact.is_some()
                || search.socketio_exact.is_some()
        })
        || search.socketio_exact.as_ref().is_some_and(|event| {
            event.key().is_none()
                || search.format != "socketio_event"
                || !search.search.is_empty()
                || search.exact.is_some()
        })
        || search.exact.as_ref().is_some_and(|exact| {
            exact.key().is_none() || search.format != "jsonpointer" || !search.search.is_empty()
        })
        || id > i64::MAX as u64
        || (search.format == "jsonpointer" && json_pointer::tokens(&search.pointer).is_none())
        || (search.format != "jsonpointer" && !search.pointer.is_empty())
        || search.search.len()
            > if search.format == "jsonrpc_id" {
                65536
            } else {
                4096
            }
        || !["", "sent", "received"].contains(&search.direction.as_str())
        || ![
            "",
            "text",
            "utf8",
            "msgpack",
            "protobuf",
            "hex",
            "hex_mask",
            "protocol_field",
            "socketio_event",
            "cdp_method",
            "cdp_id",
            "jsonrpc_method",
            "jsonrpc_id",
            "content_kind",
            "jsonpointer",
        ]
        .contains(&search.format.as_str())
        || (search.format == "content_kind" && ws_profile::Kind::parse(&search.search).is_none())
        || (search.format == "jsonrpc_id" && jsonrpc::normalize_id_query(&search.search).is_none())
        || (search.format == "cdp_id" && cdp_related::normalize_id(&search.search).is_none())
        || (search.format == "hex" && ws_search::normalize_hex(&search.search).is_none())
        || (search.format == "hex_mask" && ws_search::normalize_hex_mask(&search.search).is_none())
        || ![
            "",
            "TEXT",
            "BINARY",
            "PING",
            "PONG",
            "CLOSE",
            "CONTINUATION",
            "DATA",
            "CONTROL",
        ]
        .contains(&search.kind.as_str())
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    read_ws(&app, move |store| {
        if ![
            "jsonpointer",
            "socketio_event",
            "protocol_field",
            "jsonrpc_method",
            "jsonrpc_id",
        ]
        .contains(&search.format.as_str())
            && search.search.is_empty()
            && search.kind.is_empty()
            && search.direction.is_empty()
        {
            store.ws_page(id, search.before)
        } else {
            store.ws_search_exact(
                id,
                search.before,
                storage::WsFilter {
                    field_exact: search.field_exact.as_ref(),
                    socketio_exact: search.socketio_exact.as_ref(),
                    query: &search.search,
                    kind: &search.kind,
                    format: &search.format,
                    direction: &search.direction,
                    pointer: &search.pointer,
                },
                search.exact.as_ref(),
            )
        }
    })
    .await
    .map(Json)
}
#[derive(Default, Deserialize)]
#[serde(default)]
struct WsExportQuery {
    after: i64,
    through: Option<i64>,
}
async fn ws_export(
    State(app): State<App>,
    Path(id): Path<u64>,
    Query(query): Query<WsExportQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64
        || query.after < 0
        || query.through.is_some_and(|end| end < query.after)
        || (query.through.is_none() && query.after != 0)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut history = app.history.lock().unwrap();
    history.flush().map_err(storage_error)?;
    history
        .store
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?
        .ws_export_page(id, query.after, query.through)
        .map_err(storage_error)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
async fn clear(State(app): State<App>) -> Result<StatusCode, StatusCode> {
    let mut history = app.history.lock().unwrap();
    history.flush().map_err(storage_error)?;
    history.clear().map_err(storage_error)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn ws_profile(
    State(app): State<App>,
    Path(id): Path<u64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 {
        return Err(StatusCode::BAD_REQUEST);
    }
    {
        let mut history = app.history.lock().unwrap();
        history.flush().map_err(storage_error)?;
    }
    read_ws(&app, move |reader| reader.ws_profile(id))
        .await?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
async fn ws_summary(
    State(app): State<App>,
    Path(id): Path<u64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 {
        return Err(StatusCode::BAD_REQUEST);
    }
    {
        let mut history = app.history.lock().unwrap();
        history.flush().map_err(storage_error)?;
    }
    read_ws(&app, move |reader| reader.ws_summary(id))
        .await?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
async fn ws_message(
    State(app): State<App>,
    Path((id, message_id)): Path<(u64, i64)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 || message_id < 1 {
        return Err(StatusCode::BAD_REQUEST);
    }
    app.history
        .lock()
        .unwrap()
        .store
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?
        .ws_message(id, message_id)
        .map_err(storage_error)?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
async fn ws_context(
    State(app): State<App>,
    Path((id, message_id)): Path<(u64, i64)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 || message_id < 1 {
        return Err(StatusCode::BAD_REQUEST);
    }
    read_ws(&app, move |reader| reader.ws_context(id, message_id))
        .await?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct JsonRpcQuery {
    entry: Option<usize>,
}
async fn ws_jsonrpc_related(
    State(app): State<App>,
    Path((id, message_id)): Path<(u64, i64)>,
    Query(query): Query<JsonRpcQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 || message_id < 1 || query.entry.is_some_and(|e| e >= 256) {
        return Err(StatusCode::BAD_REQUEST);
    }
    read_ws(&app, move |reader| {
        reader.ws_jsonrpc_related(id, message_id, query.entry)
    })
    .await?
    .map(Json)
    .ok_or(StatusCode::NOT_FOUND)
}
async fn ws_cdp_related(
    State(app): State<App>,
    Path((id, message_id)): Path<(u64, i64)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 || message_id < 1 {
        return Err(StatusCode::BAD_REQUEST);
    }
    read_ws(&app, move |reader| reader.ws_cdp_related(id, message_id))
        .await?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
async fn ws_socketio_related(
    State(app): State<App>,
    Path((id, message_id)): Path<(u64, i64)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 || message_id < 1 {
        return Err(StatusCode::BAD_REQUEST);
    }
    read_ws(&app, move |reader| {
        reader.ws_socketio_related(id, message_id)
    })
    .await?
    .map(Json)
    .ok_or(StatusCode::NOT_FOUND)
}
async fn ws_json_fields(
    State(app): State<App>,
    Path((id, message_id)): Path<(u64, i64)>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 || message_id < 1 {
        return Err(StatusCode::BAD_REQUEST);
    }
    read_ws(&app, move |reader| {
        Ok(reader
            .ws_message(id, message_id)?
            .map(|message| json_pointer::inspect(&message)))
    })
    .await?
    .map(Json)
    .ok_or(StatusCode::NOT_FOUND)
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct JsonValuesQuery {
    pointer: String,
}
async fn ws_json_values(
    State(app): State<App>,
    Path(id): Path<u64>,
    Query(query): Query<JsonValuesQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 || json_pointer::tokens(&query.pointer).is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }
    read_ws(&app, move |reader| {
        reader.ws_json_values(id, &query.pointer)
    })
    .await?
    .map(Json)
    .ok_or(StatusCode::NOT_FOUND)
}
async fn ws_field_values(
    State(app): State<App>,
    Path(id): Path<u64>,
    Json(field): Json<ws_fields::FieldSpec>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 || field.width().is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }
    read_ws(&app, move |reader| reader.ws_field_values(id, &field))
        .await?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
async fn ws_socketio_events(
    State(app): State<App>,
    Path(id): Path<u64>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 {
        return Err(StatusCode::BAD_REQUEST);
    }
    read_ws(&app, move |reader| reader.ws_socketio_events(id))
        .await?
        .map(Json)
        .ok_or(StatusCode::NOT_FOUND)
}
async fn flush(State(app): State<App>) -> Result<StatusCode, StatusCode> {
    app.history.lock().unwrap().flush().map_err(storage_error)?;
    Ok(StatusCode::NO_CONTENT)
}
async fn ws_inflate(
    State(app): State<App>,
    Path((id, message_id)): Path<(u64, i64)>,
    Query(query): Query<inflate::Query>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if id > i64::MAX as u64 || message_id < 1 || !query.valid() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let message = {
        let history = app.history.lock().unwrap();
        history
            .store
            .as_ref()
            .ok_or(StatusCode::SERVICE_UNAVAILABLE)?
            .ws_message(id, message_id)
            .map_err(storage_error)?
            .ok_or(StatusCode::NOT_FOUND)?
    };
    tokio::task::spawn_blocking(move || Json(inflate::decode(&message, &query)))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
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
        .route("/api/capture", axum::routing::post(external::ingest))
        .route("/ws-analysis.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../ui/ws-analysis.js")) }))
        .route("/capture.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../ui/capture.js")) }))
        .route("/api/traffic-page", get(page))
        .route("/api/capture-contexts", get(capture_contexts))
        .route("/api/ws-archive-search", axum::routing::post(ws_archive_search))
        .route("/ws-profile.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../ui/ws-profile.js")) }))
        .route("/jsonrpc-related.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../ui/jsonrpc-related.js")) }))
        .route("/ws-context.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../ui/ws-context.js")) }))
        .route("/ws-archive.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../ui/ws-archive.js")) }))
        .route("/capture-contexts.js", get(|| async { ([(header::CONTENT_TYPE, "text/javascript; charset=utf-8")], include_str!("../ui/capture-contexts.js")) }))
        .route("/api/storage-flush", axum::routing::post(flush))
        .route(
            "/api/info",
            get(|| async {
                Json(serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"desktop_api":1,"phone_lan":true,"persistent_history":true,"external_capture":true,"capture_sources":true,"capture_targets":true,"capture_contexts":true,"capture_context_catalogue":true,"ws_archive_search":true,"ws_context":true,"ws_jsonrpc_related":true,"ws_jsonrpc_search":true,"ws_profile":true,"ws_rpc_unique_members":true,"ws_content_search":true,"ws_export":true,"ws_close":true,"ws_protobuf":true,"ws_summary":true,"ws_message":true,"ws_hex_search":true,"ws_kind_groups":true,"ws_inflate":true,"ws_roles":true,"ws_cdp_related":true,"ws_cdp_search":true,"ws_json_pointer":true,"ws_json_fields":true,"ws_json_values":true,"ws_json_exact":true,"ws_socketio_search":true,"ws_socketio_events":true,"ws_socketio_related":true,"ws_fields":true,"ws_fields_search":true,"ws_field_values":true,"ws_timing":true,"ws_timing_links":true,"ws_hex_mask":true,"ws_hex_mask_offset":true}))
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
        .route("/api/traffic/{id}/ws-export",get(ws_export))
        .route("/api/traffic/{id}/ws-profile",get(ws_profile))
        .route("/api/traffic/{id}/ws-summary",get(ws_summary))
        .route("/api/traffic/{id}/ws-json-values",get(ws_json_values))
        .route("/api/traffic/{id}/ws-socketio-events",get(ws_socketio_events))
        .route("/api/traffic/{id}/ws-search",axum::routing::post(ws_search_post))
        .route("/api/traffic/{id}/ws-field-values",axum::routing::post(ws_field_values))
        .route("/api/traffic/{id}/ws/{message_id}/context",get(ws_context))
        .route("/api/traffic/{id}/ws/{message_id}/jsonrpc-related",get(ws_jsonrpc_related))
        .route("/api/traffic/{id}/ws/{message_id}/cdp-related",get(ws_cdp_related))
        .route("/api/traffic/{id}/ws/{message_id}/socketio-related",get(ws_socketio_related))
        .route("/api/traffic/{id}/ws/{message_id}/json-fields",get(ws_json_fields))
        .route("/api/traffic/{id}/ws/{message_id}",get(ws_message))
        .route("/api/traffic/{id}/ws/{message_id}/inflate",get(ws_inflate))
        .route("/ws-signatures.js",get(||async{ ([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../ui/ws-signatures.js")) }))
        .route("/ws-fields.js",get(||async{ ([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../ui/ws-fields.js")) }))
        .route("/ws-message.js",get(||async{ ([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../ui/ws-message.js")) }))
        .route("/ws-export.js",get(||async{ ([(header::CONTENT_TYPE,"text/javascript; charset=utf-8")],include_str!("../ui/ws-export.js")) }))
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
