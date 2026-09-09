mod ca;
mod capture;
mod decode;
mod intercept;
mod settings;
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
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct App {
    history: Shared,
    /// Read-only connection for the interface: queries run off the history lock and off the
    /// async workers, so a slow search never stalls capture.
    reader: Arc<Mutex<storage::Store>>,
    /// Raised by POST /api/shutdown: the desktop app asks for a clean exit instead of killing
    /// the process, so the last half second of traffic is flushed and the WAL is checkpointed.
    stop: Arc<tokio::sync::Notify>,
    history_path: PathBuf,
    settings: Arc<std::sync::RwLock<settings::Settings>>,
    data_dir: PathBuf,
    token: String,
    pem: String,
    hosts: [String; 2],
    info: serde_json::Value,
    intercept: intercept::Shared,
    recording: Arc<std::sync::atomic::AtomicBool>,
}

/// Data directory: LIBRIUM_DATA_DIR, else the per-user application data directory of the platform.
fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("LIBRIUM_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Librium"))
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join("Library/Application Support/Librium"))
    } else if let Some(data) = std::env::var_os("XDG_DATA_HOME") {
        Some(PathBuf::from(data).join("librium"))
    } else {
        std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/librium"))
    };
    base.unwrap_or_else(|| PathBuf::from(".local").join("Librium"))
}
fn port_from_env(name: &str, default: u16, max: u16) -> Result<u16> {
    let Some(value) = std::env::var_os(name) else {
        return Ok(default);
    };
    let value = value.to_string_lossy();
    value
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| (1..=max).contains(port))
        .with_context(|| format!("{name}={value} is not a port number in 1..={max}"))
}
#[cfg(unix)]
async fn shutdown() -> Result<()> {
    use tokio::signal::unix::{SignalKind, signal};
    // Electron's child.kill() sends SIGTERM, so it must flush the history too.
    let mut term = signal(SignalKind::terminate())?;
    tokio::select! {
        result = tokio::signal::ctrl_c() => result?,
        _ = term.recv() => {}
    }
    Ok(())
}
#[cfg(not(unix))]
async fn shutdown() -> Result<()> {
    Ok(tokio::signal::ctrl_c().await?)
}

async fn protect(State(app): State<App>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    if !app.hosts.iter().any(|allowed| allowed == host) {
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
/// SQLite work runs on the blocking pool; the history lock is taken only for the flush.
async fn blocking<T: Send + 'static>(
    task: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, StatusCode> {
    tokio::task::spawn_blocking(task)
        .await
        .map_err(storage_error)?
        .map_err(storage_error)
}
async fn list(State(app): State<App>) -> Result<Json<Vec<Summary>>, StatusCode> {
    let page = blocking(move || {
        capture::flush_shared(&app.history)?;
        app.reader
            .lock()
            .unwrap()
            .search(&storage::Search::default())
    })
    .await?;
    Ok(Json(page.rows))
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
    Ok(Json(
        blocking(move || {
            capture::flush_shared(&app.history)?;
            app.reader.lock().unwrap().search(&search)
        })
        .await?,
    ))
}
async fn traffic_stats(
    State(app): State<App>,
    Query(query): Query<PageQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let search: storage::Search =
        serde_json::from_str(&query.q).map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(Json(
        blocking(move || {
            capture::flush_shared(&app.history)?;
            app.reader.lock().unwrap().stats(&search)
        })
        .await?,
    ))
}
async fn remove_matching(
    State(app): State<App>,
    Query(query): Query<PageQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    let search: storage::Search =
        serde_json::from_str(&query.q).map_err(|_| StatusCode::BAD_REQUEST)?;
    let deleted = blocking(move || capture::delete_matching_shared(&app.history, &search)).await?;
    Ok(Json(serde_json::json!({ "deleted": deleted })))
}
async fn detail(
    State(app): State<App>,
    Path(id): Path<u64>,
) -> Result<Json<capture::SavedExchange>, StatusCode> {
    blocking(move || {
        // A transfer still in progress lives in memory. While it streams, only the preview goes to
        // the interface (nothing more is shown until it ends), so a large download does not cost
        // its whole body over the API every second; the complete body follows once it is done.
        if let Some(row) = app.history.lock().unwrap().row(id) {
            return Ok(Some(row.stored()));
        }
        app.reader.lock().unwrap().detail(id)
    })
    .await?
    .map(Json)
    .ok_or(StatusCode::NOT_FOUND)
}
#[derive(Default, Deserialize)]
struct WsQuery {
    before: Option<i64>,
    after: Option<i64>,
}
async fn ws_messages(
    State(app): State<App>,
    Path(id): Path<u64>,
    Query(query): Query<WsQuery>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    Ok(Json(
        blocking(move || {
            capture::flush_shared(&app.history)?;
            app.reader
                .lock()
                .unwrap()
                .ws_page(id, query.before, query.after)
        })
        .await?,
    ))
}
async fn remove(State(app): State<App>, Path(id): Path<u64>) -> Result<StatusCode, StatusCode> {
    let removed =
        blocking(move || capture::with_writer(&app.history, |history| history.delete(id))).await?;
    Ok(if removed {
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    })
}
async fn clear(State(app): State<App>) -> Result<StatusCode, StatusCode> {
    blocking(move || {
        capture::with_writer(&app.history, |history| {
            history.flush()?;
            history.clear()
        })
    })
    .await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn flush(State(app): State<App>) -> Result<StatusCode, StatusCode> {
    blocking(move || capture::flush_shared(&app.history)).await?;
    Ok(StatusCode::NO_CONTENT)
}
async fn stop(State(app): State<App>) -> StatusCode {
    app.stop.notify_one();
    StatusCode::NO_CONTENT
}
/// Cheap enough to poll every second: no flush, no query. `disk` is what the history
/// currently occupies, database file plus write-ahead log; `error` is set while the history
/// cannot be written, so the interface does not mistake a frozen revision for a quiet network.
async fn state(State(app): State<App>) -> Result<Json<serde_json::Value>, StatusCode> {
    blocking(move || {
        let (revision, error) = {
            let history = app.history.lock().unwrap();
            (history.revision, history.storage_error.clone())
        };
        let size = |suffix: &str| {
            let mut path = app.history_path.clone().into_os_string();
            path.push(suffix);
            std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
        };
        let held = app.intercept.lock().unwrap().held();
        // Counts of the rules that change traffic, so the interface can show they are on.
        let tweaks = {
            let settings = app.settings.read().unwrap();
            serde_json::json!({
                "mocks": settings.mocks.iter().filter(|m| m.enabled).count(),
                "delays": settings.delays.len(),
                "rewrites": settings.rewrites.len() + settings.response_rewrites.len(),
                "ignored": settings.ignore_hosts.len(),
            })
        };
        let recording = app.recording.load(std::sync::atomic::Ordering::Relaxed);
        Ok(serde_json::json!({ "revision": revision, "disk": size("") + size("-wal"), "error": error, "held": held, "tweaks": tweaks, "recording": recording }))
    })
    .await
    .map(Json)
}
#[derive(Deserialize)]
struct Recording {
    enabled: bool,
}
async fn get_recording(State(app): State<App>) -> Json<serde_json::Value> {
    Json(serde_json::json!({ "enabled": app.recording.load(std::sync::atomic::Ordering::Relaxed) }))
}
async fn put_recording(State(app): State<App>, Json(body): Json<Recording>) -> StatusCode {
    app.recording
        .store(body.enabled, std::sync::atomic::Ordering::Relaxed);
    StatusCode::NO_CONTENT
}
async fn get_intercept(State(app): State<App>) -> Json<serde_json::Value> {
    Json(app.intercept.lock().unwrap().view())
}
async fn put_intercept(
    State(app): State<App>,
    Json(rules): Json<intercept::Rules>,
) -> Result<StatusCode, StatusCode> {
    app.intercept
        .lock()
        .unwrap()
        .set_rules(rules)
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    Ok(StatusCode::NO_CONTENT)
}
/// Forwards (with edits) or drops one held request; 404 once it is no longer held.
async fn decide_intercept(
    State(app): State<App>,
    Path(id): Path<u64>,
    Json(decision): Json<intercept::Decision>,
) -> Result<StatusCode, StatusCode> {
    let edit = decision.validate().map_err(|_| StatusCode::BAD_REQUEST)?;
    if app.intercept.lock().unwrap().decide(id, edit) {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}
/// A star and/or a note on one exchange; absent fields stay as they are.
#[derive(serde::Deserialize)]
struct Mark {
    starred: Option<bool>,
    note: Option<String>,
}
async fn mark(
    State(app): State<App>,
    Path(id): Path<u64>,
    Json(mark): Json<Mark>,
) -> Result<StatusCode, StatusCode> {
    if mark.note.as_ref().is_some_and(|note| note.len() > 4096) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let found = blocking(move || {
        capture::with_writer(&app.history, |history| {
            history.mark(id, mark.starred, mark.note.as_deref())
        })
    })
    .await?;
    if found {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(StatusCode::NOT_FOUND)
    }
}
/// Exchanges made elsewhere, from an imported HAR: appended with fresh ids.
async fn import(
    State(app): State<App>,
    Json(rows): Json<Vec<capture::ImportedExchange>>,
) -> Result<Json<serde_json::Value>, StatusCode> {
    if rows.len() > 100_000 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let count = blocking(move || {
        capture::with_writer(&app.history, |history| {
            let count = history.import(rows)?;
            history.flush()?;
            Ok(count)
        })
    })
    .await?;
    Ok(Json(serde_json::json!({ "imported": count })))
}
async fn get_settings(State(app): State<App>) -> Json<settings::Settings> {
    Json(app.settings.read().unwrap().clone())
}
/// A partial update: a field that is absent keeps its current value, so a client that knows
/// only the ignore list cannot wipe the rewrites and vice versa.
#[derive(serde::Deserialize)]
struct SettingsPatch {
    ignore_hosts: Option<Vec<String>>,
    rewrites: Option<Vec<settings::Rewrite>>,
    response_rewrites: Option<Vec<settings::Rewrite>>,
    delays: Option<Vec<settings::Delay>>,
    mocks: Option<Vec<settings::Mock>>,
}
async fn put_settings(
    State(app): State<App>,
    Json(patch): Json<SettingsPatch>,
) -> Result<StatusCode, StatusCode> {
    let mut merged = app.settings.read().unwrap().clone();
    if let Some(hosts) = patch.ignore_hosts {
        merged.ignore_hosts = hosts;
    }
    if let Some(rewrites) = patch.rewrites {
        merged.rewrites = rewrites;
    }
    if let Some(rewrites) = patch.response_rewrites {
        merged.response_rewrites = rewrites;
    }
    if let Some(delays) = patch.delays {
        merged.delays = delays;
    }
    if let Some(mocks) = patch.mocks {
        merged.mocks = mocks;
    }
    let normalized = merged.normalized().map_err(|_| StatusCode::BAD_REQUEST)?;
    blocking({
        let normalized = normalized.clone();
        move || normalized.save(&app.data_dir)
    })
    .await?;
    *app.settings.write().unwrap() = normalized;
    Ok(StatusCode::NO_CONTENT)
}
async fn info(State(app): State<App>) -> Json<serde_json::Value> {
    Json(app.info)
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

/// An embedded interface file with its media type.
fn asset(content_type: &'static str, body: &'static str) -> axum::routing::MethodRouter<App> {
    get(move || async move { ([(header::CONTENT_TYPE, content_type)], body) })
}
fn router(app: App) -> Router {
    const SCRIPT: &str = "text/javascript; charset=utf-8";
    Router::new()
        .route("/", get(index))
        .route(
            "/style.css",
            asset("text/css; charset=utf-8", include_str!("../ui/style.css")),
        )
        .route("/app.js", asset(SCRIPT, include_str!("../ui/app.js")))
        .route("/i18n.js", asset(SCRIPT, include_str!("../ui/i18n.js")))
        .route(
            "/filters.js",
            asset(SCRIPT, include_str!("../ui/filters.js")),
        )
        .route("/params.js", asset(SCRIPT, include_str!("../ui/params.js")))
        .route(
            "/suggest.js",
            asset(SCRIPT, include_str!("../ui/suggest.js")),
        )
        .route("/curl.js", asset(SCRIPT, include_str!("../ui/curl.js")))
        .route("/mobile.js", asset(SCRIPT, include_str!("../ui/mobile.js")))
        .route("/api/traffic", get(list).delete(clear))
        .route("/api/traffic-page", get(page).delete(remove_matching))
        .route("/api/traffic-stats", get(traffic_stats))
        .route("/api/intercept", get(get_intercept).put(put_intercept))
        .route("/api/recording", get(get_recording).put(put_recording))
        .route(
            "/api/intercept/{id}",
            axum::routing::post(decide_intercept)
                .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024)),
        )
        .route("/api/traffic/{id}", get(detail).delete(remove).patch(mark))
        .route("/api/traffic/{id}/ws", get(ws_messages))
        .route("/api/storage-flush", axum::routing::post(flush))
        .route("/api/shutdown", axum::routing::post(stop))
        .route("/api/info", get(info))
        .route("/api/state", get(state))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route(
            "/api/import",
            axum::routing::post(import)
                .layer(axum::extract::DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        .route("/api/ca", get(certificate))
        .layer(middleware::from_fn_with_state(app.clone(), protect))
        .with_state(app)
}

#[tokio::main]
async fn main() -> Result<()> {
    let _ = aws_lc_rs::default_provider().install_default();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()),
        )
        .init();
    let dir = data_dir();
    let ui_port = port_from_env("LIBRIUM_UI_PORT", 3000, 65535)?;
    // The phone certificate page uses proxy_port + 1, so the proxy cannot take the last port.
    let proxy_port = port_from_env("LIBRIUM_PROXY_PORT", 8080, 65534)?;
    let (authority, pem) = ca::load(&dir)?;
    let history_path = dir.join("history.sqlite3");
    let history = Arc::new(Mutex::new(capture::History::open(&history_path)?));
    let reader = Arc::new(Mutex::new(storage::Store::open_reader(&history_path)?));
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
                if let Err(error) = capture::flush_shared(&h) {
                    eprintln!("Librium history storage: {error}");
                }
            })
            .await;
        }
    });
    let stop_signal = Arc::new(tokio::sync::Notify::new());
    // A damaged settings file must not keep the proxy from starting: say so and use the defaults.
    let settings = Arc::new(std::sync::RwLock::new(
        settings::Settings::load(&dir).unwrap_or_else(|error| {
            eprintln!("Librium settings: {error:#}; using the defaults");
            settings::Settings::default()
        }),
    ));
    let intercept = intercept::Shared::default();
    let recording = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let app = App {
        history: history.clone(),
        reader,
        stop: stop_signal.clone(),
        history_path,
        settings: settings.clone(),
        intercept: intercept.clone(),
        recording: recording.clone(),
        data_dir: dir.clone(),
        token: uuid::Uuid::new_v4().to_string(),
        pem,
        hosts: [
            format!("127.0.0.1:{ui_port}"),
            format!("localhost:{ui_port}"),
        ],
        info: serde_json::json!({"version":env!("CARGO_PKG_VERSION"),"phone_lan":true,"persistent_history":true,
            "ui_port":ui_port,"proxy_port":proxy_port,"data_dir":dir.display().to_string()}),
    };
    let router = router(app);
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", ui_port))
        .await
        .with_context(|| {
            format!("UI port {ui_port} is busy (set LIBRIUM_UI_PORT to use another port)")
        })?;
    let proxy_listener = tokio::net::TcpListener::bind(("127.0.0.1", proxy_port))
        .await
        .with_context(|| {
            format!("Proxy port {proxy_port} is busy (set LIBRIUM_PROXY_PORT to use another port)")
        })?;
    let proxy = Proxy::builder()
        .with_listener(proxy_listener)
        .with_ca(authority)
        .with_rustls_connector(aws_lc_rs::default_provider())
        .with_http_handler(Capture {
            history: history.clone(),
            current: None,
            control_ports: [ui_port, proxy_port, proxy_port.saturating_add(1)],
            settings: settings.clone(),
            intercept: intercept.clone(),
            recording: recording.clone(),
        })
        .build()
        .with_context(|| {
            format!(
                "Cannot build proxy on 127.0.0.1:{proxy_port} (set LIBRIUM_PROXY_PORT to use another port)"
            )
        })?;
    println!(
        "Librium\n  UI:    http://127.0.0.1:{ui_port}\n  Proxy: 127.0.0.1:{proxy_port}\n  CA:    {}\nCtrl+C to stop",
        dir.join("ca.crt").display()
    );
    tokio::select! {
        result = proxy.start() => result.context("Proxy stopped")?,
        result = axum::serve(listener, router) => result.context("UI stopped")?,
        result = shutdown() => result?,
        _ = stop_signal.notified() => {}
    }
    writer.abort();
    capture::with_writer(&history, |history| history.close())?;
    Ok(())
}
