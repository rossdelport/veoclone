//! The HTTP API (DESIGN.md section 4.5) and the static editor files.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Path as UrlPath, Query, Request, State};
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    HOST, RANGE,
};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post, put};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tower::ServiceExt;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

use crate::ai::AiStatus;
use crate::calib::{DEFAULT_LENS, is_lens_option, lens_options};
use crate::export::{ExportBody, validate};
use crate::jobs::{Job, Jobs};
use crate::media::Tools;
use crate::store::{
    DERIVED_FILES, ExportMeta, ExportStatus, FileInfo, Files, ProjectMeta, Status, Store, Style,
    dir_size, end_unfinished_run, new_id, now_iso, original_file, valid_id, write_atomic,
};

const EDITS_LIMIT: usize = 10 * 1024 * 1024;
/// The camera path of a long match, plus the most text boxes allowed
/// (base64 makes them a third bigger).
const EXPORT_LIMIT: usize =
    64 * 1024 * 1024 + crate::export::MAX_OVERLAYS * crate::export::MAX_OVERLAY_PNG / 3 * 4;
const JSON_LIMIT: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct GpuInfo {
    pub name: String,
    pub backend: String,
}

/// Facts about this helper shown by `/api/health`.
pub struct HelperInfo {
    pub data_dir: PathBuf,
    pub tools: Tools,
    pub gpu: Mutex<GpuInfo>,
    pub ai: Mutex<Option<AiStatus>>,
    pub model: Option<PathBuf>,
}

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub jobs: Arc<Jobs>,
    pub info: Arc<HelperInfo>,
    /// Uploads in progress per project (processing waits for them).
    pub uploads: Arc<Mutex<HashMap<String, usize>>>,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// `{ "error": "plain words", "detail": "technical" }` with a status code.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
    detail: Option<String>,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> ApiError {
        ApiError {
            status,
            message: message.into(),
            detail: None,
        }
    }

    pub fn detail(mut self, detail: impl std::fmt::Display) -> ApiError {
        self.detail = Some(detail.to_string());
        self
    }

    fn bad_request(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::BAD_REQUEST, message)
    }

    fn conflict(message: impl Into<String>) -> ApiError {
        ApiError::new(StatusCode::CONFLICT, message)
    }

    fn internal(message: impl Into<String>, detail: impl std::fmt::Display) -> ApiError {
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, message).detail(detail)
    }

    fn no_project() -> ApiError {
        ApiError::new(StatusCode::NOT_FOUND, "This match no longer exists.")
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({ "error": self.message });
        if let Some(d) = self.detail {
            body["detail"] = Value::String(d);
        }
        (self.status, axum::Json(body)).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn json<T: Serialize>(value: &T) -> Response {
    axum::Json(value).into_response()
}

const BUSY: &str = "This match is busy. Wait for it to finish or press Cancel first.";

/// Read a JSON request body of at most `limit` bytes.
async fn read_json<T: serde::de::DeserializeOwned>(body: Body, limit: usize) -> ApiResult<T> {
    let bytes = axum::body::to_bytes(body, limit).await.map_err(|e| {
        ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "The request is too big.").detail(e)
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::bad_request("The request was not understood.").detail(e))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/// Origins the editor can be opened from.
pub fn default_origins(port: u16) -> Vec<String> {
    vec![
        "https://rossdelport.github.io".into(),
        "http://localhost:5173".into(),
        "http://127.0.0.1:5173".into(),
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ]
}

pub fn router(state: AppState, port: u16, origins: &[String], web_dir: &Path) -> Router {
    let api = Router::new()
        .route("/health", get(health))
        .route("/lenses", get(lenses))
        .route("/projects", get(list_projects).post(create_project))
        .route(
            "/projects/{id}",
            get(get_project).patch(patch_project).delete(delete_project),
        )
        .route("/projects/{id}/files/{side}", put(upload))
        .route("/projects/{id}/process", post(process))
        .route("/projects/{id}/cancel", post(cancel))
        .route("/projects/{id}/calibration", get(calibration))
        .route("/projects/{id}/proxy.mp4", get(proxy))
        .route("/projects/{id}/ai-path.bin", get(ai_path))
        .route("/projects/{id}/edits", get(get_edits).put(put_edits))
        .route("/projects/{id}/exports", post(create_export))
        .route(
            "/projects/{id}/exports/{eid}",
            axum::routing::delete(delete_export),
        )
        .route("/projects/{id}/exports/{eid}/file", get(export_file))
        .route("/projects/{id}/open-folder", post(open_folder))
        .route("/projects/{id}/swap", post(swap))
        .fallback(|| async {
            ApiError::new(StatusCode::NOT_FOUND, "Unknown address.").into_response()
        });

    let web: Router<AppState> = if web_dir.join("index.html").is_file() {
        Router::new().fallback_service(ServeDir::new(web_dir))
    } else {
        log::warn!("Editor files not found in {}", web_dir.display());
        Router::new().fallback(|| async {
            Html(
                "<h1>VeoClone</h1><p>The editor files are missing from this copy of \
                 VeoClone. Please download VeoClone again, or open the online editor at \
                 <a href=\"https://rossdelport.github.io/veoclone/\">\
                 rossdelport.github.io/veoclone</a>.</p>",
            )
        })
    };

    let origins: Vec<HeaderValue> = origins
        .iter()
        .filter_map(|o| HeaderValue::from_str(o.trim_end_matches('/')).ok())
        .collect();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins.clone()))
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
        ])
        .allow_headers([CONTENT_TYPE, RANGE, HeaderName::from_static("x-filename")])
        .expose_headers([CONTENT_RANGE, CONTENT_LENGTH, ACCEPT_RANGES])
        .allow_private_network(true)
        .max_age(Duration::from_secs(600));

    let allowed = Arc::new(Allowed {
        hosts: vec![format!("127.0.0.1:{port}"), format!("localhost:{port}")],
        origins,
    });
    Router::new()
        .nest("/api", api)
        .merge(web)
        .layer(DefaultBodyLimit::disable())
        .layer(cors)
        .layer(middleware::from_fn_with_state(allowed, guard))
        .with_state(state)
}

struct Allowed {
    hosts: Vec<String>,
    origins: Vec<HeaderValue>,
}

/// Only answer requests addressed to us (DNS-rebinding protection), and only
/// let the editor's own origins change anything (other web pages cannot
/// read our answers because of CORS, but could still send simple POSTs).
/// Nothing may be shown inside another web page's frame, where a hidden
/// editor could be clicked by mistake (clickjacking).
async fn guard(State(allowed): State<Arc<Allowed>>, req: Request, next: Next) -> Response {
    let host_ok = req
        .headers()
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|h| allowed.hosts.iter().any(|a| a.eq_ignore_ascii_case(h)));
    let safe = matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let origin_ok = safe
        || req
            .headers()
            .get("origin")
            .is_none_or(|o| allowed.origins.contains(o));
    if host_ok && origin_ok {
        let mut res = next.run(req).await;
        let h = res.headers_mut();
        h.insert("x-frame-options", HeaderValue::from_static("DENY"));
        h.insert(
            "content-security-policy",
            HeaderValue::from_static("frame-ancestors 'none'"),
        );
        res
    } else {
        ApiError::new(
            StatusCode::FORBIDDEN,
            format!(
                "This address is not allowed. Open VeoClone at http://{}/",
                allowed.hosts[0]
            ),
        )
        .into_response()
    }
}

// ---------------------------------------------------------------------------
// Helper & lenses
// ---------------------------------------------------------------------------

async fn health(State(s): State<AppState>) -> Response {
    let info = &s.info;
    let gpu = info.gpu.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let ai = info
        .ai
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .unwrap_or_else(|| AiStatus {
            available: false,
            provider: "checking".into(),
            model: info.model.as_ref().map(|m| {
                m.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned()
            }),
        });
    json(&json!({
        "app": "veoclone-helper",
        "version": env!("CARGO_PKG_VERSION"),
        "gpu": gpu,
        "ai": ai,
        "ffmpeg": info.tools.ffmpeg.is_some() && info.tools.ffprobe.is_some(),
        "dataDir": info.data_dir.to_string_lossy(),
        "freeDiskBytes": fs4::available_space(&info.data_dir).unwrap_or(0),
    }))
}

async fn lenses() -> Response {
    let list = tokio::task::spawn_blocking(|| lens_options().to_vec())
        .await
        .unwrap_or_default();
    json(&list)
}

const UNKNOWN_LENS: &str = "That iPhone and lens are not in the list.";

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

fn project(s: &AppState, id: &str) -> ApiResult<ProjectMeta> {
    if !valid_id(id) {
        return Err(ApiError::no_project());
    }
    s.store.get(id).ok_or_else(ApiError::no_project)
}

async fn list_projects(State(s): State<AppState>) -> Response {
    json(&s.store.list())
}

async fn get_project(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Response> {
    Ok(json(&project(&s, &id)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewProject {
    name: String,
    #[serde(default)]
    lens_id: Option<String>,
    #[serde(default)]
    style: Option<Style>,
}

fn clean_name(name: &str) -> ApiResult<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("Please give the match a name."));
    }
    Ok(name.chars().take(200).collect())
}

async fn create_project(State(s): State<AppState>, body: Body) -> ApiResult<Response> {
    let req: NewProject = read_json(body, JSON_LIMIT).await?;
    let name = clean_name(&req.name)?;
    let lens_id = req.lens_id.unwrap_or_else(|| DEFAULT_LENS.into());
    if !is_lens_option(&lens_id) {
        return Err(ApiError::bad_request(UNKNOWN_LENS));
    }
    let now = now_iso();
    let meta = ProjectMeta {
        id: new_id(),
        name,
        created_at: now.clone(),
        updated_at: now,
        lens_id: Some(lens_id),
        style: req.style.unwrap_or(Style::Broadcast),
        status: Status::New,
        files: Files::default(),
        job: None,
        error: None,
        warnings: Vec::new(),
        calibration: None,
        fps: None,
        frame_count: None,
        disk_bytes: 0,
        exports: Vec::new(),
        interrupted_runs: 0,
    };
    let meta = s
        .store
        .create(meta)
        .map_err(|e| ApiError::internal("We couldn't create the match folder.", e))?;
    Ok((StatusCode::CREATED, axum::Json(meta)).into_response())
}

async fn patch_project(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
    body: Body,
) -> ApiResult<Response> {
    project(&s, &id)?;
    let req: serde_json::Map<String, Value> = read_json(body, JSON_LIMIT).await?;
    let name = match req.get("name") {
        Some(Value::String(n)) => Some(clean_name(n)?),
        None | Some(Value::Null) => None,
        Some(_) => return Err(ApiError::bad_request("The name must be text.")),
    };
    let lens = match req.get("lensId") {
        None => None,
        Some(Value::Null) => Some(Some(DEFAULT_LENS.to_string())),
        Some(Value::String(l)) if is_lens_option(l) => Some(Some(l.clone())),
        Some(_) => return Err(ApiError::bad_request(UNKNOWN_LENS)),
    };
    let style: Option<Style> = match req.get("style") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            serde_json::from_value(v.clone())
                .map_err(|_| ApiError::bad_request("Unknown camera style."))?,
        ),
    };
    let changes_processing = lens.is_some() || style.is_some();
    if changes_processing && s.jobs.busy(&id) {
        return Err(ApiError::conflict(BUSY));
    }
    let (meta, _) = s
        .store
        .update(&id, |m| {
            if let Some(n) = name {
                m.name = n;
            }
            if let Some(l) = lens
                && l != m.lens_id
            {
                m.lens_id = l;
                // Forces a new calibration on the next "process"; the old
                // results stay usable until then.
                m.calibration = None;
            }
            if let Some(st) = style {
                m.style = st;
            }
        })
        .ok_or_else(ApiError::no_project)?;
    Ok(json(&meta))
}

async fn delete_project(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Response> {
    project(&s, &id)?;
    if s.jobs.running(&id) || s.uploads.lock().unwrap().get(&id).is_some_and(|n| *n > 0) {
        return Err(ApiError::conflict(BUSY));
    }
    s.jobs.cancel(&id);
    s.store.delete(&id).map_err(|e| {
        ApiError::internal(
            "Some files of this match are still in use. Close any program that uses them \
             and try again.",
            e,
        )
    })?;
    Ok(json(&json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |c: u8| (c as char).to_digit(16);
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2]))
        {
            out.push((h * 16 + l) as u8);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Lower-case extension of the original file name, `mp4` if none.
fn extension(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .filter(|e| !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .filter(|e| e != "part" && e != "tmp")
        .unwrap_or_else(|| "mp4".into())
}

const NO_SPACE: &str =
    "There is not enough free disk space for this video. Free up some space and try again.";

struct UploadGuard {
    uploads: Arc<Mutex<HashMap<String, usize>>>,
    id: String,
}

impl Drop for UploadGuard {
    fn drop(&mut self) {
        let mut u = self.uploads.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = u.get_mut(&self.id) {
            *n -= 1;
            if *n == 0 {
                u.remove(&self.id);
            }
        }
    }
}

async fn upload(
    State(s): State<AppState>,
    UrlPath((id, side)): UrlPath<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    project(&s, &id)?;
    if side != "left" && side != "right" {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Unknown camera side."));
    }
    if s.jobs.busy(&id) {
        return Err(ApiError::conflict(BUSY));
    }
    let name = headers
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| format!("{side}.mp4"));
    let dir = s.store.project_dir(&id);
    if let Some(len) = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        && let Ok(free) = fs4::available_space(&dir)
        && free < len + 200 * 1024 * 1024
    {
        return Err(ApiError::new(StatusCode::INSUFFICIENT_STORAGE, NO_SPACE));
    }

    *s.uploads.lock().unwrap().entry(id.clone()).or_default() += 1;
    let _guard = UploadGuard {
        uploads: s.uploads.clone(),
        id: id.clone(),
    };

    let part = dir.join(format!("{side}.{}.part", new_id()));
    let size = match write_body(&part, body).await {
        Ok(n) => n,
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            if e.kind() == std::io::ErrorKind::StorageFull {
                return Err(ApiError::new(StatusCode::INSUFFICIENT_STORAGE, NO_SPACE).detail(e));
            }
            return Err(
                ApiError::bad_request("The upload did not finish. Please try again.").detail(e),
            );
        }
    };
    if size == 0 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(ApiError::bad_request("That file is empty."));
    }
    if s.jobs.busy(&id) {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(ApiError::conflict(BUSY));
    }

    // Replace the old original and drop everything made from it.
    while let Some(old) = original_file(&dir, &side) {
        tokio::fs::remove_file(&old)
            .await
            .map_err(|e| ApiError::internal("The old video could not be replaced.", e))?;
    }
    for f in DERIVED_FILES {
        let _ = tokio::fs::remove_file(dir.join(f)).await;
    }
    let dest = dir.join(format!("{side}.{}", extension(&name)));
    tokio::fs::rename(&part, &dest)
        .await
        .map_err(|e| ApiError::internal("The video could not be saved.", e))?;

    let info = FileInfo {
        name,
        size_bytes: size,
        probe: None,
    };
    let (mut meta, _) = s
        .store
        .update(&id, |m| {
            if side == "left" {
                m.files.left = Some(info);
            } else {
                m.files.right = Some(info);
            }
            m.status = if m.files.left.is_some() && m.files.right.is_some() {
                Status::Uploaded
            } else {
                Status::New
            };
            m.calibration = None;
            m.fps = None;
            m.frame_count = None;
            m.error = None;
            m.warnings.clear();
        })
        .ok_or_else(ApiError::no_project)?;
    meta.disk_bytes = dir_size(&dir);
    Ok(json(&meta))
}

async fn write_body(path: &Path, body: Body) -> std::io::Result<u64> {
    let file = tokio::fs::File::create(path).await?;
    let mut out = tokio::io::BufWriter::with_capacity(1 << 20, file);
    let mut stream = body.into_data_stream();
    let mut size = 0u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(std::io::Error::other)?;
        out.write_all(&chunk).await?;
        size += chunk.len() as u64;
    }
    out.flush().await?;
    Ok(size)
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async fn process(State(s): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    let meta = project(&s, &id)?;
    if s.jobs.busy(&id) || s.uploads.lock().unwrap().get(&id).is_some_and(|n| *n > 0) {
        return Err(ApiError::conflict(BUSY));
    }
    let dir = s.store.project_dir(&id);
    if meta.files.left.is_none()
        || meta.files.right.is_none()
        || original_file(&dir, "left").is_none()
        || original_file(&dir, "right").is_none()
    {
        return Err(ApiError::bad_request(
            "Both videos are needed. Add the left and the right phone's video first.",
        ));
    }
    let (meta, _) = s
        .store
        .update(&id, |m| {
            m.status = Status::Queued;
            m.error = None;
        })
        .ok_or_else(ApiError::no_project)?;
    s.jobs.submit(Job::Process {
        project: id.clone(),
    });
    Ok(json(&meta))
}

async fn cancel(State(s): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    project(&s, &id)?;
    let dir = s.store.project_dir(&id);
    let removed = s.jobs.cancel(&id);
    let (meta, _) = s
        .store
        .update(&id, |m| {
            for job in &removed {
                match job {
                    Job::Process { .. } => end_unfinished_run(m, &dir, None),
                    Job::Export { export, .. } => {
                        if let Some(e) = m.exports.iter_mut().find(|e| &e.id == export) {
                            e.status = ExportStatus::Cancelled;
                        }
                    }
                }
            }
        })
        .ok_or_else(ApiError::no_project)?;
    Ok(json(&meta))
}

/// Swap the left and right videos without uploading them again: the most
/// common reason the two views cannot be lined up.
async fn swap(State(s): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    project(&s, &id)?;
    if s.jobs.busy(&id) || s.uploads.lock().unwrap().get(&id).is_some_and(|n| *n > 0) {
        return Err(ApiError::conflict(BUSY));
    }
    let dir = s.store.project_dir(&id);
    let files = tokio::task::spawn_blocking(move || swap_files(&dir))
        .await
        .map_err(|e| ApiError::internal("The videos could not be swapped.", e))?;
    files.map_err(|e| {
        ApiError::internal(
            "The videos could not be swapped. Close any program that uses them and try again.",
            e,
        )
    })?;
    let (meta, _) = s
        .store
        .update(&id, |m| {
            std::mem::swap(&mut m.files.left, &mut m.files.right);
            m.status = if m.files.left.is_some() && m.files.right.is_some() {
                Status::Uploaded
            } else {
                Status::New
            };
            m.calibration = None;
            m.fps = None;
            m.frame_count = None;
            m.error = None;
            m.warnings.clear();
        })
        .ok_or_else(ApiError::no_project)?;
    Ok(json(&meta))
}

/// Rename `left.*` to `right.*` and back (each keeps its extension), then
/// drop everything made from the old order.
fn swap_files(dir: &Path) -> std::io::Result<()> {
    let ext = |p: &Path| {
        p.extension()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    };
    let left = original_file(dir, "left");
    let right = original_file(dir, "right");
    // Park the left video under another name so the two never clash.
    let parked = dir.join("swapping");
    if let Some(l) = &left {
        std::fs::rename(l, &parked)?;
    }
    if let Some(r) = &right
        && let Err(e) = std::fs::rename(r, dir.join(format!("left.{}", ext(r))))
    {
        if let Some(l) = &left {
            let _ = std::fs::rename(&parked, l);
        }
        return Err(e);
    }
    if let Some(l) = &left {
        std::fs::rename(&parked, dir.join(format!("right.{}", ext(l))))?;
    }
    for f in DERIVED_FILES {
        let _ = std::fs::remove_file(dir.join(f));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Editor data
// ---------------------------------------------------------------------------

const NOT_PROCESSED: &str = "This match has not been processed yet.";

async fn calibration(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Response> {
    project(&s, &id)?;
    let bytes = tokio::fs::read(s.store.project_dir(&id).join("calib.json"))
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, NOT_PROCESSED))?;
    Ok(([(CONTENT_TYPE, "application/json")], bytes).into_response())
}

/// Serve a file with HTTP Range support.
async fn serve_file(path: PathBuf, req: Request) -> ApiResult<Response> {
    if !path.is_file() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, NOT_PROCESSED));
    }
    let res = ServeFile::new(&path)
        .oneshot(req)
        .await
        .map_err(|e| ApiError::internal("The file could not be read.", e))?;
    let mut res = res.map(Body::new);
    res.headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    Ok(res)
}

async fn proxy(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
    req: Request,
) -> ApiResult<Response> {
    project(&s, &id)?;
    serve_file(s.store.project_dir(&id).join("proxy.mp4"), req).await
}

async fn ai_path(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
    req: Request,
) -> ApiResult<Response> {
    project(&s, &id)?;
    let mut res = serve_file(s.store.project_dir(&id).join("ai_path.bin"), req).await?;
    res.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    Ok(res)
}

async fn get_edits(State(s): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    project(&s, &id)?;
    let bytes = tokio::fs::read(s.store.project_dir(&id).join("edits.json"))
        .await
        .unwrap_or_else(|_| b"{}".to_vec());
    Ok(([(CONTENT_TYPE, "application/json")], bytes).into_response())
}

async fn put_edits(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
    body: Body,
) -> ApiResult<Response> {
    project(&s, &id)?;
    let edits: Value = read_json(body, EDITS_LIMIT).await?;
    if !edits.is_object() {
        return Err(ApiError::bad_request("The edits must be a JSON object."));
    }
    let path = s.store.project_dir(&id).join("edits.json");
    let bytes = serde_json::to_vec(&edits).expect("json");
    tokio::task::spawn_blocking(move || write_atomic(&path, &bytes))
        .await
        .map_err(|e| ApiError::internal("Your edits could not be saved.", e))?
        .map_err(|e| ApiError::internal("Your edits could not be saved.", e))?;
    Ok(json(&json!({ "ok": true })))
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

async fn create_export(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
    body: Body,
) -> ApiResult<Response> {
    let meta = project(&s, &id)?;
    let dir = s.store.project_dir(&id);
    let frame_count = match (meta.status, meta.frame_count) {
        (Status::Ready, Some(n)) if dir.join("match.json").is_file() => n,
        _ => {
            return Err(ApiError::conflict(
                "This match is not ready to export yet. Wait until processing has finished.",
            ));
        }
    };
    if s.jobs.processing(&id) {
        return Err(ApiError::conflict(BUSY));
    }
    let body: ExportBody = read_json(body, EXPORT_LIMIT).await?;
    let request = validate(body, frame_count).map_err(ApiError::bad_request)?;
    let export = ExportMeta {
        id: new_id(),
        status: ExportStatus::Queued,
        progress: 0.0,
        created_at: now_iso(),
        file_name: None,
        size_bytes: None,
        width: request.width,
        height: request.height,
        quality: request.quality,
        error: None,
    };
    s.store
        .update(&id, |m| m.exports.push(export.clone()))
        .ok_or_else(ApiError::no_project)?;
    s.jobs.submit(Job::Export {
        project: id,
        export: export.id.clone(),
        request: Arc::new(request),
    });
    Ok((StatusCode::CREATED, axum::Json(export)).into_response())
}

fn find_export(meta: &ProjectMeta, eid: &str) -> ApiResult<ExportMeta> {
    meta.exports
        .iter()
        .find(|e| e.id == eid)
        .cloned()
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "This video no longer exists."))
}

/// `attachment` with an ASCII fallback name and the real UTF-8 name.
pub fn content_disposition(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_graphic() || c == ' ' {
                c
            } else {
                '_'
            }
        })
        .filter(|c| *c != '"' && *c != '\\')
        .collect();
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename=\"{ascii}\"; filename*=UTF-8''{encoded}")
}

async fn export_file(
    State(s): State<AppState>,
    UrlPath((id, eid)): UrlPath<(String, String)>,
    req: Request,
) -> ApiResult<Response> {
    let meta = project(&s, &id)?;
    let export = find_export(&meta, &eid)?;
    let Some(name) = export
        .file_name
        .filter(|_| export.status == ExportStatus::Done)
    else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "This video is not finished yet.",
        ));
    };
    let path = s
        .store
        .project_dir(&id)
        .join("exports")
        .join(&eid)
        .join(&name);
    let mut res = serve_file(path, req).await?;
    if let Ok(v) = HeaderValue::from_str(&content_disposition(&name)) {
        res.headers_mut().insert(CONTENT_DISPOSITION, v);
    }
    Ok(res)
}

async fn delete_export(
    State(s): State<AppState>,
    UrlPath((id, eid)): UrlPath<(String, String)>,
) -> ApiResult<Response> {
    let meta = project(&s, &id)?;
    find_export(&meta, &eid)?;
    if !valid_id(&eid) {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "This video no longer exists.",
        ));
    }
    if s.jobs.export_running(&id, &eid) {
        return Err(ApiError::conflict(
            "This video is still being made. Press Cancel first.",
        ));
    }
    s.jobs.remove_queued_export(&id, &eid);
    let dir = s.store.project_dir(&id).join("exports").join(&eid);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| {
            ApiError::internal(
                "The video is still in use. Close any program that plays it and try again.",
                e,
            )
        })?;
    }
    let (meta, _) = s
        .store
        .update(&id, |m| m.exports.retain(|e| e.id != eid))
        .ok_or_else(ApiError::no_project)?;
    Ok(json(&meta))
}

#[derive(Deserialize)]
struct FolderQuery {
    export: Option<String>,
}

async fn open_folder(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
    Query(q): Query<FolderQuery>,
) -> ApiResult<Response> {
    let meta = project(&s, &id)?;
    let mut dir = s.store.project_dir(&id);
    if let Some(eid) = q.export {
        find_export(&meta, &eid)?;
        dir = dir.join("exports").join(eid);
    }
    open::that_detached(&dir)
        .map_err(|e| ApiError::internal("The folder could not be opened.", e))?;
    Ok(json(&json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::Context;
    use axum::http::Request as HttpRequest;

    fn state() -> (tempfile::TempDir, AppState) {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(tmp.path()).unwrap());
        let jobs = Jobs::start(Context {
            store: store.clone(),
            tools: Tools::default(),
            model: None,
        });
        let info = Arc::new(HelperInfo {
            data_dir: tmp.path().to_path_buf(),
            tools: Tools::default(),
            gpu: Mutex::new(GpuInfo {
                name: "Test GPU".into(),
                backend: "Vulkan".into(),
            }),
            ai: Mutex::new(None),
            model: None,
        });
        let st = AppState {
            store,
            jobs,
            info,
            uploads: Default::default(),
        };
        (tmp, st)
    }

    fn app(st: &AppState) -> Router {
        router(
            st.clone(),
            47863,
            &default_origins(47863),
            Path::new("/nonexistent"),
        )
    }

    async fn call(
        app: &Router,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: impl Into<Body>,
    ) -> (StatusCode, HeaderMap, Vec<u8>) {
        let mut req = HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header("host", "127.0.0.1:47863");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        let res = app
            .clone()
            .oneshot(req.body(body.into()).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = axum::body::to_bytes(res.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        (status, headers, bytes)
    }

    fn v(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).unwrap()
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn project_lifecycle() {
        rt().block_on(async {
            let (_tmp, st) = state();
            let app = app(&st);
            let (code, _, b) = call(&app, "POST", "/api/projects", &[], r#"{"name":"  "}"#).await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            assert!(v(&b)["error"].as_str().unwrap().contains("name"));

            let (code, _, b) = call(
                &app,
                "POST",
                "/api/projects",
                &[],
                r#"{"name":"Cup final","style":"action"}"#,
            )
            .await;
            assert_eq!(code, StatusCode::CREATED);
            let p = v(&b);
            let id = p["id"].as_str().unwrap().to_string();
            assert_eq!(p["status"], "new");
            assert_eq!(p["style"], "action");
            assert_eq!(p["lensId"], DEFAULT_LENS);

            let (code, _, b) = call(&app, "GET", "/api/projects", &[], "").await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(v(&b).as_array().unwrap().len(), 1);

            let lens = lens_options()[2].id.clone();
            let body = json!({"name":"Final","lensId":lens,"style":"frame_all"}).to_string();
            let (code, _, b) = call(&app, "PATCH", &format!("/api/projects/{id}"), &[], body).await;
            assert_eq!(code, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
            assert_eq!(v(&b)["name"], "Final");
            assert_eq!(v(&b)["lensId"], lens.as_str());
            assert_eq!(v(&b)["style"], "frame_all");
            let (code, _, _) = call(
                &app,
                "PATCH",
                &format!("/api/projects/{id}"),
                &[],
                r#"{"lensId":"nope"}"#,
            )
            .await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            let (_, _, b) = call(
                &app,
                "PATCH",
                &format!("/api/projects/{id}"),
                &[],
                r#"{"lensId":null}"#,
            )
            .await;
            assert_eq!(v(&b)["lensId"], DEFAULT_LENS);
            let (code, _, _) = call(
                &app,
                "POST",
                "/api/projects",
                &[],
                r#"{"name":"x","lensId":"Apple IPhone 15||3840x2160"}"#,
            )
            .await;
            assert_eq!(code, StatusCode::BAD_REQUEST);

            // Processing needs both files.
            let (code, _, b) = call(
                &app,
                "POST",
                &format!("/api/projects/{id}/process"),
                &[],
                "",
            )
            .await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            assert!(v(&b)["error"].as_str().unwrap().contains("Both videos"));

            // Upload (streamed) left and right.
            let (code, _, b) = call(
                &app,
                "PUT",
                &format!("/api/projects/{id}/files/left"),
                &[("x-filename", "IMG%201234.MOV")],
                vec![7u8; 100_000],
            )
            .await;
            assert_eq!(code, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
            let p = v(&b);
            assert_eq!(p["files"]["left"]["name"], "IMG 1234.MOV");
            assert_eq!(p["files"]["left"]["sizeBytes"], 100_000);
            assert_eq!(p["status"], "new");
            let dir = st.store.project_dir(&id);
            assert_eq!(std::fs::read(dir.join("left.mov")).unwrap().len(), 100_000);
            let (code, _, _) = call(
                &app,
                "PUT",
                &format!("/api/projects/{id}/files/middle"),
                &[],
                "x",
            )
            .await;
            assert_eq!(code, StatusCode::NOT_FOUND);
            std::fs::write(dir.join("proxy.mp4"), b"old").unwrap();
            let (_, _, b) = call(
                &app,
                "PUT",
                &format!("/api/projects/{id}/files/right"),
                &[("x-filename", "b.mp4")],
                "right-data",
            )
            .await;
            assert_eq!(v(&b)["status"], "uploaded");
            assert!(!dir.join("proxy.mp4").exists(), "derived files are removed");
            assert!(v(&b)["diskBytes"].as_u64().unwrap() >= 100_010);

            // Not processed yet.
            for path in ["calibration", "proxy.mp4", "ai-path.bin"] {
                let (code, _, b) =
                    call(&app, "GET", &format!("/api/projects/{id}/{path}"), &[], "").await;
                assert_eq!(code, StatusCode::NOT_FOUND, "{path}");
                assert!(v(&b)["error"].is_string());
            }
            let (code, _, _) = call(
                &app,
                "POST",
                &format!("/api/projects/{id}/exports"),
                &[],
                "{}",
            )
            .await;
            assert_eq!(code, StatusCode::CONFLICT);

            // Edits.
            let (_, _, b) = call(&app, "GET", &format!("/api/projects/{id}/edits"), &[], "").await;
            assert_eq!(v(&b), json!({}));
            let (code, _, _) = call(
                &app,
                "PUT",
                &format!("/api/projects/{id}/edits"),
                &[],
                r#"{"version":1,"zoom":1.2}"#,
            )
            .await;
            assert_eq!(code, StatusCode::OK);
            let (_, _, b) = call(&app, "GET", &format!("/api/projects/{id}/edits"), &[], "").await;
            assert_eq!(v(&b)["zoom"], 1.2);
            let (code, _, _) = call(
                &app,
                "PUT",
                &format!("/api/projects/{id}/edits"),
                &[],
                "[1,2]",
            )
            .await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            let big = format!("{{\"x\":\"{}\"}}", "a".repeat(EDITS_LIMIT));
            let (code, _, b) =
                call(&app, "PUT", &format!("/api/projects/{id}/edits"), &[], big).await;
            assert_eq!(code, StatusCode::PAYLOAD_TOO_LARGE);
            assert!(v(&b)["error"].is_string());

            // Cancel with nothing running is harmless; delete removes the folder.
            let (code, _, _) =
                call(&app, "POST", &format!("/api/projects/{id}/cancel"), &[], "").await;
            assert_eq!(code, StatusCode::OK);
            let (code, _, _) = call(&app, "DELETE", &format!("/api/projects/{id}"), &[], "").await;
            assert_eq!(code, StatusCode::OK);
            assert!(!dir.exists());
            let (code, _, _) = call(&app, "GET", &format!("/api/projects/{id}"), &[], "").await;
            assert_eq!(code, StatusCode::NOT_FOUND);
            let (code, _, _) = call(&app, "GET", "/api/projects/..%2F..", &[], "").await;
            assert_eq!(code, StatusCode::NOT_FOUND);
        });
    }

    #[test]
    fn serves_ranges_and_editor_data() {
        rt().block_on(async {
            let (_tmp, st) = state();
            let app = app(&st);
            let (_, _, b) = call(&app, "POST", "/api/projects", &[], r#"{"name":"x"}"#).await;
            let id = v(&b)["id"].as_str().unwrap().to_string();
            let dir = st.store.project_dir(&id);
            let data: Vec<u8> = (0..=255).collect();
            std::fs::write(dir.join("proxy.mp4"), &data).unwrap();
            std::fs::write(dir.join("ai_path.bin"), &data[..24]).unwrap();
            std::fs::write(dir.join("calib.json"), br#"{"frameCount":2}"#).unwrap();

            let (code, h, b) = call(
                &app,
                "GET",
                &format!("/api/projects/{id}/proxy.mp4"),
                &[("range", "bytes=10-19")],
                "",
            )
            .await;
            assert_eq!(code, StatusCode::PARTIAL_CONTENT);
            assert_eq!(h[CONTENT_RANGE], "bytes 10-19/256");
            assert_eq!(h[CONTENT_TYPE], "video/mp4");
            assert_eq!(b, data[10..20].to_vec());
            let (code, h, b) = call(
                &app,
                "GET",
                &format!("/api/projects/{id}/ai-path.bin"),
                &[],
                "",
            )
            .await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(h[CONTENT_TYPE], "application/octet-stream");
            assert_eq!(b.len(), 24);
            let (_, h, b) = call(
                &app,
                "GET",
                &format!("/api/projects/{id}/calibration"),
                &[],
                "",
            )
            .await;
            assert_eq!(h[CONTENT_TYPE], "application/json");
            assert_eq!(v(&b)["frameCount"], 2);

            // A finished export downloads as an attachment with ranges.
            let eid = "e1abc".to_string();
            let edir = dir.join("exports").join(&eid);
            std::fs::create_dir_all(&edir).unwrap();
            std::fs::write(edir.join("Cup final 2026.mp4"), &data).unwrap();
            st.store.update(&id, |m| {
                m.exports.push(ExportMeta {
                    id: eid.clone(),
                    status: ExportStatus::Done,
                    progress: 1.0,
                    created_at: now_iso(),
                    file_name: Some("Cup final 2026.mp4".into()),
                    size_bytes: Some(256),
                    width: 1920,
                    height: 1080,
                    quality: crate::store::Quality::High,
                    error: None,
                })
            });
            let (code, h, b) = call(
                &app,
                "GET",
                &format!("/api/projects/{id}/exports/{eid}/file"),
                &[("range", "bytes=250-")],
                "",
            )
            .await;
            assert_eq!(code, StatusCode::PARTIAL_CONTENT);
            assert_eq!(b, data[250..].to_vec());
            assert!(
                h[CONTENT_DISPOSITION]
                    .to_str()
                    .unwrap()
                    .starts_with("attachment;")
            );
            let (code, _, b) = call(
                &app,
                "DELETE",
                &format!("/api/projects/{id}/exports/{eid}"),
                &[],
                "",
            )
            .await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(v(&b)["exports"], json!([]));
            assert!(!edir.exists());
        });
    }

    #[test]
    fn host_check_and_cors() {
        rt().block_on(async {
            let (_tmp, st) = state();
            let app = app(&st);
            let req = HttpRequest::builder()
                .uri("/api/health")
                .header("host", "evil.example:47863")
                .body(Body::empty())
                .unwrap();
            let res = app.clone().oneshot(req).await.unwrap();
            assert_eq!(res.status(), StatusCode::FORBIDDEN);
            let req = HttpRequest::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(req).await.unwrap().status(),
                StatusCode::FORBIDDEN
            );

            let (code, _, b) = call(
                &app,
                "GET",
                "/api/health",
                &[("origin", "https://rossdelport.github.io")],
                "",
            )
            .await;
            assert_eq!(code, StatusCode::OK);
            let h = v(&b);
            assert_eq!(h["app"], "veoclone-helper");
            assert_eq!(h["gpu"]["name"], "Test GPU");
            assert_eq!(h["ffmpeg"], false);

            let (code, h, _) = call(
                &app,
                "OPTIONS",
                "/api/projects/x/files/left",
                &[
                    ("origin", "https://rossdelport.github.io"),
                    ("access-control-request-method", "PUT"),
                    ("access-control-request-headers", "x-filename,content-type"),
                    ("access-control-request-private-network", "true"),
                ],
                "",
            )
            .await;
            assert!(code.is_success());
            assert_eq!(
                h["access-control-allow-origin"],
                "https://rossdelport.github.io"
            );
            assert_eq!(h["access-control-allow-private-network"], "true");
            assert!(
                h["access-control-allow-headers"]
                    .to_str()
                    .unwrap()
                    .contains("x-filename")
            );

            let (_, h, _) = call(
                &app,
                "GET",
                "/api/projects",
                &[("origin", "https://evil.example")],
                "",
            )
            .await;
            assert!(h.get("access-control-allow-origin").is_none());
            let (code, _, _) = call(
                &app,
                "POST",
                "/api/projects",
                &[("origin", "https://evil.example")],
                r#"{"name":"x"}"#,
            )
            .await;
            assert_eq!(
                code,
                StatusCode::FORBIDDEN,
                "foreign pages cannot change things"
            );
            let (code, _, _) = call(
                &app,
                "POST",
                "/api/projects",
                &[("origin", "https://rossdelport.github.io")],
                r#"{"name":"x"}"#,
            )
            .await;
            assert_eq!(code, StatusCode::CREATED);
            let (_, h, _) = call(
                &app,
                "GET",
                "/api/projects",
                &[("origin", "http://localhost:5173")],
                "",
            )
            .await;
            assert_eq!(h["access-control-allow-origin"], "http://localhost:5173");
            assert!(
                h["access-control-expose-headers"]
                    .to_str()
                    .unwrap()
                    .to_lowercase()
                    .contains("content-range")
            );

            let (code, _, b) = call(&app, "GET", "/api/nope", &[], "").await;
            assert_eq!(code, StatusCode::NOT_FOUND);
            assert!(v(&b)["error"].is_string());
            let (code, _, b) = call(&app, "GET", "/", &[], "").await;
            assert_eq!(code, StatusCode::OK);
            assert!(String::from_utf8_lossy(&b).contains("VeoClone"));

            let (_, _, b) = call(&app, "GET", "/api/lenses", &[], "").await;
            let l = v(&b);
            assert_eq!(l.as_array().unwrap().len(), lens_options().len());
            assert_eq!(l[0]["id"], DEFAULT_LENS);
            assert_eq!(l[0]["model"], "Not sure");
            assert_eq!(l[0]["lens"], "ultra");
            assert!(l[0]["label"].is_string() && l[0]["note"].is_string());
        });
    }

    /// No page can show VeoClone inside a frame (clickjacking).
    #[test]
    fn refuses_to_be_framed() {
        rt().block_on(async {
            let (_tmp, st) = state();
            let app = app(&st);
            for uri in ["/", "/api/projects"] {
                let (code, h, _) = call(&app, "GET", uri, &[], "").await;
                assert_eq!(code, StatusCode::OK);
                assert_eq!(h["x-frame-options"], "DENY");
                assert_eq!(h["content-security-policy"], "frame-ancestors 'none'");
            }
        });
    }

    #[test]
    fn swap_left_and_right() {
        rt().block_on(async {
            let (_tmp, st) = state();
            let app = app(&st);
            let (_, _, b) = call(&app, "POST", "/api/projects", &[], r#"{"name":"x"}"#).await;
            let id = v(&b)["id"].as_str().unwrap().to_string();
            let dir = st.store.project_dir(&id);
            for (side, name, data) in [("left", "A.MOV", "aaa"), ("right", "b.mp4", "bbbb")] {
                let uri = format!("/api/projects/{id}/files/{side}");
                call(&app, "PUT", &uri, &[("x-filename", name)], data).await;
            }
            for f in DERIVED_FILES {
                std::fs::write(dir.join(f), b"old").unwrap();
            }
            st.store.update(&id, |m| m.status = Status::Ready);

            let uri = format!("/api/projects/{id}/swap");
            let (code, _, b) = call(&app, "POST", &uri, &[], "").await;
            assert_eq!(code, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
            let p = v(&b);
            assert_eq!(p["status"], "uploaded");
            assert_eq!(p["files"]["left"]["name"], "b.mp4");
            assert_eq!(p["files"]["right"]["name"], "A.MOV");
            assert_eq!(std::fs::read(dir.join("left.mp4")).unwrap(), b"bbbb");
            assert_eq!(std::fs::read(dir.join("right.mov")).unwrap(), b"aaa");
            assert!(DERIVED_FILES.iter().all(|f| !dir.join(f).exists()));
            let names = std::fs::read_dir(&dir).unwrap().count();
            assert_eq!(names, 3, "project.json, left.mp4, right.mov");

            // And back.
            call(&app, "POST", &uri, &[], "").await;
            assert_eq!(std::fs::read(dir.join("left.mov")).unwrap(), b"aaa");
            assert_eq!(std::fs::read(dir.join("right.mp4")).unwrap(), b"bbbb");
        });
    }

    /// DESIGN.md 4.7 through the real job queue: a re-run that fails leaves
    /// the match ready with its earlier result.
    #[test]
    fn failed_rerun_keeps_the_editor_open() {
        rt().block_on(async {
            let (_tmp, st) = state();
            let app = app(&st);
            let (_, _, b) = call(&app, "POST", "/api/projects", &[], r#"{"name":"x"}"#).await;
            let id = v(&b)["id"].as_str().unwrap().to_string();
            let dir = st.store.project_dir(&id);
            for side in ["left", "right"] {
                let uri = format!("/api/projects/{id}/files/{side}");
                call(&app, "PUT", &uri, &[("x-filename", "a.mp4")], "data").await;
            }
            for f in DERIVED_FILES {
                std::fs::write(dir.join(f), b"x").unwrap();
            }
            std::fs::write(dir.join("calib.json"), br#"{"frameCount":588}"#).unwrap();
            st.store.update(&id, |m| {
                m.status = Status::Ready;
                m.frame_count = Some(588);
            });

            // The test has no ffmpeg, so the re-run fails straight away.
            let uri = format!("/api/projects/{id}/process");
            let (code, _, _) = call(&app, "POST", &uri, &[], "").await;
            assert_eq!(code, StatusCode::OK);
            let mut p = st.store.get(&id).unwrap();
            for _ in 0..200 {
                if !st.jobs.busy(&id) && p.status != Status::Queued {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
                p = st.store.get(&id).unwrap();
            }
            assert_eq!(p.status, Status::Ready, "{p:?}");
            assert_eq!(p.frame_count, Some(588));
            assert!(p.error.is_none());
            assert!(
                p.warnings.iter().any(|w| w.contains("ffmpeg")),
                "{:?}",
                p.warnings
            );
        });
    }

    #[test]
    fn helpers() {
        assert_eq!(percent_decode("IMG%201.MOV"), "IMG 1.MOV");
        assert_eq!(percent_decode("Caf%C3%A9.mov"), "Café.mov");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(extension("a.MOV"), "mov");
        assert_eq!(extension("noext"), "mp4");
        assert_eq!(extension("x.part"), "mp4");
        assert_eq!(extension("x.a/b"), "mp4");
        assert_eq!(
            content_disposition("Café final.mp4"),
            "attachment; filename=\"Caf_ final.mp4\"; filename*=UTF-8''Caf%C3%A9%20final.mp4"
        );
    }
}
