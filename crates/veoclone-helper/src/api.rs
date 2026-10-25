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
    AiAccuracy, DERIVED_FILES, ExportMeta, ExportStatus, FileInfo, Files, MAX_PARTS, PartInfo,
    PitchOutline, ProjectMeta, Status, Store, Style, dir_size, end_unfinished_run, new_id, now_iso,
    remove_matched, side_files, uploaded_files, valid_id, write_atomic,
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
    /// Self-update (DESIGN.md 4.11).
    pub updater: Arc<crate::update::Updater>,
    pub settings: Arc<crate::settings::SettingsStore>,
    pub shortcuts: Arc<crate::shortcuts::Shortcuts>,
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
pub(crate) async fn read_json<T: serde::de::DeserializeOwned>(
    body: Body,
    limit: usize,
) -> ApiResult<T> {
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
        .route("/projects/{id}/ai-report", get(ai_report))
        .route("/projects/{id}/edits", get(get_edits).put(put_edits))
        .route("/projects/{id}/pitch", put(put_pitch).delete(delete_pitch))
        .route("/projects/{id}/exports", post(create_export))
        .route(
            "/projects/{id}/exports/{eid}",
            axum::routing::delete(delete_export),
        )
        .route("/projects/{id}/exports/{eid}/file", get(export_file))
        .route("/projects/{id}/open-folder", post(open_folder))
        .route("/projects/{id}/swap", post(swap))
        .route("/update/check", post(crate::update::check))
        .route("/update/install", post(crate::update::install))
        .route(
            "/settings",
            get(crate::update::get_settings).patch(crate::update::patch_settings),
        )
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
    let activity = state.updater.activity.clone();
    Router::new()
        .nest("/api", api)
        .merge(web)
        .layer(middleware::from_fn_with_state(
            activity,
            crate::update::track,
        ))
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
        "version": s.updater.build().to_json(),
        "update": s.updater.status(),
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
    /// The right phone's lens when it is another model; `None`: the same.
    #[serde(default)]
    right_lens_id: Option<String>,
    #[serde(default)]
    style: Option<Style>,
    #[serde(default)]
    ai_accuracy: Option<AiAccuracy>,
    #[serde(default)]
    widest_view: Option<crate::seen::WidestView>,
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
    if !is_lens_option(&lens_id)
        || req
            .right_lens_id
            .as_deref()
            .is_some_and(|l| !is_lens_option(l))
    {
        return Err(ApiError::bad_request(UNKNOWN_LENS));
    }
    let now = now_iso();
    let meta = ProjectMeta {
        id: new_id(),
        name,
        created_at: now.clone(),
        updated_at: now,
        lens_id: Some(lens_id),
        right_lens_id: req.right_lens_id,
        style: req.style.unwrap_or(Style::NEW_MATCH),
        ai_accuracy: req.ai_accuracy.unwrap_or_default(),
        widest_view: Some(
            req.widest_view
                .unwrap_or(crate::seen::WidestView::NEW_MATCH),
        ),
        pitch: None,
        ai_run: None,
        ai_seen: None,
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
    // `null`: the right phone is the same model as the left one.
    let right_lens = match req.get("rightLensId") {
        None => None,
        Some(Value::Null) => Some(None),
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
    let accuracy: Option<AiAccuracy> = match req.get("aiAccuracy") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            serde_json::from_value(v.clone())
                .map_err(|_| ApiError::bad_request("Unknown AI accuracy."))?,
        ),
    };
    let widest: Option<crate::seen::WidestView> = match req.get("widestView") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            serde_json::from_value(v.clone())
                .map_err(|_| ApiError::bad_request("Unknown widest view."))?,
        ),
    };
    let changes_processing = lens.is_some()
        || right_lens.is_some()
        || style.is_some()
        || accuracy.is_some()
        || widest.is_some();
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
            if let Some(r) = right_lens
                && r != m.right_lens_id
            {
                m.right_lens_id = r;
                m.calibration = None;
            }
            if let Some(st) = style {
                m.style = st;
            }
            if let Some(a) = accuracy {
                m.ai_accuracy = a;
            }
            if let Some(w) = widest {
                m.widest_view = Some(w);
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

/// `?part=N&parts=M` on an upload: part N (from 1) of a recording the
/// camera split into M files (GoPro chapters).
#[derive(Deserialize)]
struct PartQuery {
    part: Option<String>,
    parts: Option<String>,
}

impl PartQuery {
    /// `None`: one file (no query, or part 1 of 1).
    fn part(&self) -> ApiResult<Option<(usize, usize)>> {
        let number = |v: &Option<String>| v.as_deref().and_then(|n| n.parse::<usize>().ok());
        match (&self.part, &self.parts) {
            (None, None) => Ok(None),
            _ => match (number(&self.part), number(&self.parts)) {
                (Some(1), Some(1)) => Ok(None),
                (Some(n), Some(m)) if n >= 1 && n <= m && m <= MAX_PARTS => Ok(Some((n, m))),
                (Some(_), Some(m)) if m > MAX_PARTS => Err(ApiError::bad_request(format!(
                    "A video can be made of at most {MAX_PARTS} files."
                ))),
                _ => Err(ApiError::bad_request("The upload was not understood.")),
            },
        }
    }
}

async fn upload(
    State(s): State<AppState>,
    UrlPath((id, side)): UrlPath<(String, String)>,
    Query(query): Query<PartQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    project(&s, &id)?;
    if side != "left" && side != "right" {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "Unknown camera side."));
    }
    let part = query.part()?;
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

    let upload = dir.join(format!("{side}.{}.part", new_id()));
    let size = match write_body(&upload, body).await {
        Ok(n) => n,
        Err(e) => {
            let _ = tokio::fs::remove_file(&upload).await;
            if e.kind() == std::io::ErrorKind::StorageFull {
                return Err(ApiError::new(StatusCode::INSUFFICIENT_STORAGE, NO_SPACE).detail(e));
            }
            return Err(
                ApiError::bad_request("The upload did not finish. Please try again.").detail(e),
            );
        }
    };
    if size == 0 {
        let _ = tokio::fs::remove_file(&upload).await;
        return Err(ApiError::bad_request("That file is empty."));
    }
    if s.jobs.busy(&id) {
        let _ = tokio::fs::remove_file(&upload).await;
        return Err(ApiError::conflict(BUSY));
    }

    // Replace the old original (one file: all of it; a part: that part,
    // and parts beyond the new number of parts) and drop everything made
    // from it.
    let replaced = |n: Option<usize>| match (part, n) {
        (None, _) | (Some(_), None) => true,
        (Some((new, count)), Some(old)) => old == new || old > count,
    };
    for (n, old) in side_files(&dir, &side) {
        if replaced(n) {
            tokio::fs::remove_file(&old)
                .await
                .map_err(|e| ApiError::internal("The old video could not be replaced.", e))?;
        }
    }
    remove_matched(&dir, &side);
    for f in DERIVED_FILES.into_iter().chain(crate::seen::SEEN_FILES) {
        let _ = tokio::fs::remove_file(dir.join(f)).await;
    }
    let dest = match part {
        None => dir.join(format!("{side}.{}", extension(&name))),
        Some((n, _)) => dir.join(format!("{side}.{n:03}.{}", extension(&name))),
    };
    tokio::fs::rename(&upload, &dest)
        .await
        .map_err(|e| ApiError::internal("The video could not be saved.", e))?;

    let (mut meta, _) = s
        .store
        .update(&id, |m| {
            let file = m.files.side_mut(&side);
            *file = Some(match part {
                None => FileInfo::single(name, size),
                Some((n, count)) => {
                    let mut parts = file.take().map(|f| f.parts).unwrap_or_default();
                    parts.resize(count, None);
                    parts[n - 1] = Some(PartInfo {
                        name,
                        size_bytes: size,
                    });
                    FileInfo::from_parts(parts)
                }
            });
            m.status = if m.files.both() {
                Status::Uploaded
            } else {
                Status::New
            };
            m.calibration = None;
            m.fps = None;
            m.frame_count = None;
            m.error = None;
            m.warnings.clear();
            // Marked on the old video.
            m.pitch = None;
            m.ai_run = None;
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
    if uploaded_files(&meta, &dir, "left").is_none()
        || uploaded_files(&meta, &dir, "right").is_none()
    {
        return Err(ApiError::bad_request(
            "Both videos are needed. Add the left and the right phone's video first \
             (with all their files, when a camera split its video into several).",
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
            // Two different phones: each keeps its own lens.
            if let Some(right) = m.right_lens_id.take() {
                let left = m.lens_id.replace(right);
                m.right_lens_id = Some(left.unwrap_or_else(|| DEFAULT_LENS.into()));
            }
            m.status = if m.files.both() {
                Status::Uploaded
            } else {
                Status::New
            };
            m.calibration = None;
            m.fps = None;
            m.frame_count = None;
            m.error = None;
            m.warnings.clear();
            // Marked on the videos the other way round.
            m.pitch = None;
            m.ai_run = None;
        })
        .ok_or_else(ApiError::no_project)?;
    Ok(json(&meta))
}

/// Rename `left.*` to `right.*` and back (each file keeps its part number
/// and extension, so `left.002.mp4` becomes `right.002.mp4`), then drop
/// everything made from the old order (also the matching copies). All or
/// nothing: when a rename fails, the ones already done are undone.
fn swap_files(dir: &Path) -> std::io::Result<()> {
    // "left.002.mp4" -> "002.mp4"
    let rest = |side: &str, p: &Path| {
        let name = p.file_name().unwrap_or_default().to_string_lossy();
        name[side.len() + 1..].to_string()
    };
    let mut renames = Vec::new();
    // Park the left video under other names first so the two never clash.
    for (_, l) in side_files(dir, "left") {
        renames.push((
            l.clone(),
            dir.join(format!("swapping.{}", rest("left", &l))),
        ));
    }
    for (_, r) in side_files(dir, "right") {
        renames.push((r.clone(), dir.join(format!("left.{}", rest("right", &r)))));
    }
    for (_, l) in side_files(dir, "left") {
        let parked = dir.join(format!("swapping.{}", rest("left", &l)));
        renames.push((parked, dir.join(format!("right.{}", rest("left", &l)))));
    }
    for (i, (from, to)) in renames.iter().enumerate() {
        if let Err(e) = std::fs::rename(from, to) {
            for (from, to) in renames[..i].iter().rev() {
                let _ = std::fs::rename(to, from);
            }
            return Err(e);
        }
    }
    for side in ["left", "right"] {
        remove_matched(dir, side);
    }
    for f in DERIVED_FILES {
        let _ = std::fs::remove_file(dir.join(f));
    }
    crate::seen::remove(dir);
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

/// The AI report (DESIGN.md 4.13): one zip with what the AI saw, the
/// calibration, the settings and the AI path, for tuning the camera.
async fn ai_report(State(s): State<AppState>, UrlPath(id): UrlPath<String>) -> ApiResult<Response> {
    let meta = project(&s, &id)?;
    if s.jobs.busy(&id) {
        return Err(ApiError::conflict(BUSY));
    }
    let dir = s.store.project_dir(&id);
    let helper = s.updater.build().to_json().to_string();
    let built = tokio::task::spawn_blocking(move || crate::report::build(&dir, &meta, &helper))
        .await
        .map_err(|e| ApiError::internal("We couldn't make the AI report.", e))?;
    match built {
        Ok(bytes) => {
            let mut res = Response::new(Body::from(bytes));
            let h = res.headers_mut();
            h.insert(CONTENT_TYPE, HeaderValue::from_static("application/zip"));
            h.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
            if let Ok(v) = HeaderValue::from_str(&content_disposition(&crate::report::file_name()))
            {
                h.insert(CONTENT_DISPOSITION, v);
            }
            Ok(res)
        }
        Err(crate::report::ReportError::Missing(m)) => Err(ApiError::new(StatusCode::NOT_FOUND, m)),
        Err(crate::report::ReportError::Failed(e)) => {
            Err(ApiError::internal("We couldn't make the AI report.", e))
        }
    }
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
// Pitch outline ("Mark the pitch")
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PitchBody {
    points: Vec<[f64; 2]>,
    left: Vec<[f64; 2]>,
    right: Vec<[f64; 2]>,
}

/// Check an outline from the editor (DESIGN.md 4.8).
fn validate_pitch(body: PitchBody) -> Result<PitchOutline, String> {
    use std::f64::consts::{FRAC_PI_2, PI};
    let bad = || "The pitch outline was not understood. Please mark the pitch again.".to_string();
    if body.points.len() < 3 || body.points.len() > 100 {
        return Err(bad());
    }
    let aims_ok = body.points.iter().all(|[yaw, pitch]| {
        yaw.is_finite() && pitch.is_finite() && yaw.abs() <= PI + 1e-6 && pitch.abs() <= FRAC_PI_2
    });
    let polygon_ok = |p: &Vec<[f64; 2]>| {
        (p.is_empty() || (3..=500).contains(&p.len()))
            && p.iter()
                .flatten()
                .all(|v| v.is_finite() && (-0.01..=1.01).contains(v))
    };
    if !aims_ok || !polygon_ok(&body.left) || !polygon_ok(&body.right) {
        return Err(bad());
    }
    if body.left.is_empty() && body.right.is_empty() {
        return Err(
            "The outline does not cover any part of the two videos. Click the corners \
                    of the pitch on the picture."
                .into(),
        );
    }
    Ok(PitchOutline {
        id: new_id(),
        points: body.points,
        left: body.left,
        right: body.right,
    })
}

async fn put_pitch(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
    body: Body,
) -> ApiResult<Response> {
    project(&s, &id)?;
    let body: PitchBody = read_json(body, JSON_LIMIT).await?;
    let outline = validate_pitch(body).map_err(ApiError::bad_request)?;
    let (meta, _) = s
        .store
        .update(&id, |m| m.pitch = Some(outline))
        .ok_or_else(ApiError::no_project)?;
    Ok(json(&meta))
}

async fn delete_pitch(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> ApiResult<Response> {
    project(&s, &id)?;
    let (meta, _) = s
        .store
        .update(&id, |m| m.pitch = None)
        .ok_or_else(ApiError::no_project)?;
    Ok(json(&meta))
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
        let uploads: Arc<Mutex<HashMap<String, usize>>> = Default::default();
        let settings = Arc::new(crate::settings::SettingsStore::open(tmp.path()));
        let updater = crate::update::Updater::new(
            crate::update::Config {
                build: crate::update::Build::dev(),
                install: tmp.path().to_path_buf(),
                data_dir: tmp.path().to_path_buf(),
                url: crate::update::DEFAULT_URL.into(),
                relaunch: Vec::new(),
                updated_from: None,
            },
            settings.clone(),
            Arc::new(crate::update::AppWork {
                jobs: jobs.clone(),
                uploads: uploads.clone(),
            }),
        );
        let st = AppState {
            store,
            jobs,
            info,
            uploads,
            updater,
            settings,
            shortcuts: Arc::new(crate::shortcuts::Shortcuts::new(PathBuf::from("VeoClone"))),
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
            assert_eq!(p["aiAccuracy"], "best", "every frame by default");
            assert_eq!(p["widestView"], "natural", "new matches look like Veo");
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
            let uri = format!("/api/projects/{id}");
            let (code, _, b) = call(&app, "PATCH", &uri, &[], r#"{"style":"ball"}"#).await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(v(&b)["style"], "ball");
            let (code, _, b) = call(&app, "PATCH", &uri, &[], r#"{"style":"wild"}"#).await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            assert_eq!(v(&b)["error"], "Unknown camera style.");
            let (_, _, b) = call(&app, "PATCH", &uri, &[], r#"{"aiAccuracy":"faster"}"#).await;
            assert_eq!(v(&b)["aiAccuracy"], "faster");
            let (code, _, b) = call(&app, "PATCH", &uri, &[], r#"{"aiAccuracy":"perfect"}"#).await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            assert_eq!(v(&b)["error"], "Unknown AI accuracy.");
            let (_, _, b) = call(&app, "PATCH", &uri, &[], r#"{"widestView":"widest"}"#).await;
            assert_eq!(v(&b)["widestView"], "widest");
            let (code, _, b) = call(&app, "PATCH", &uri, &[], r#"{"widestView":"huge"}"#).await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            assert_eq!(v(&b)["error"], "Unknown widest view.");
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
            for path in ["calibration", "proxy.mp4", "ai-path.bin", "ai-report"] {
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

            // The AI report, once there is a record of what the AI saw: a
            // zip without the match's name.
            let report = format!("/api/projects/{id}/ai-report");
            let (code, _, b) = call(&app, "GET", &report, &[], "").await;
            assert_eq!(code, StatusCode::NOT_FOUND);
            assert!(v(&b)["error"].as_str().unwrap().contains("no AI report"));
            std::fs::write(dir.join("ai_seen.bin.gz"), b"seen").unwrap();
            std::fs::write(dir.join("ai_seen.json"), b"{}").unwrap();
            std::fs::write(dir.join("match.json"), b"{}").unwrap();
            let (code, h, b) = call(&app, "GET", &report, &[], "").await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(h[CONTENT_TYPE], "application/zip");
            let cd = h[CONTENT_DISPOSITION].to_str().unwrap();
            assert!(
                cd.starts_with("attachment; filename=\"veoclone-ai-report-"),
                "{cd}"
            );
            let zip = dir.join("../report-test.zip");
            std::fs::write(&zip, &b).unwrap();
            let out = dir.join("../report-test");
            let names = crate::unzip::extract(&zip, crate::report::PREFIX, &out).unwrap();
            assert!(names.contains(&"settings.json".to_string()), "{names:?}");
            let settings = std::fs::read_to_string(out.join("settings.json")).unwrap();
            assert!(!settings.contains(&st.store.get(&id).unwrap().name));

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
            for f in DERIVED_FILES.into_iter().chain([
                "matched-left.mp4",
                "matched-left.json",
                "matched-right.mp4",
            ]) {
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
            assert_eq!(
                names, 3,
                "project.json, left.mp4, right.mov (no matching copies)"
            );
            // One phone model for both: nothing to swap.
            assert_eq!(
                (&p["lensId"], &p["rightLensId"]),
                (&json!(DEFAULT_LENS), &Value::Null)
            );

            // And back, with two different phones: each keeps its lens.
            let lenses =
                json!({"lensId": "iphone-13-pro-max:ultra", "rightLensId": "iphone-11:ultra"});
            call(
                &app,
                "PATCH",
                &format!("/api/projects/{id}"),
                &[],
                lenses.to_string(),
            )
            .await;
            let (_, _, b) = call(&app, "POST", &uri, &[], "").await;
            assert_eq!(std::fs::read(dir.join("left.mov")).unwrap(), b"aaa");
            assert_eq!(std::fs::read(dir.join("right.mp4")).unwrap(), b"bbbb");
            assert_eq!(v(&b)["lensId"], "iphone-11:ultra");
            assert_eq!(v(&b)["rightLensId"], "iphone-13-pro-max:ultra");
        });
    }

    /// A GoPro splits a long recording into several files: each is sent as
    /// a part, the match is ready when every part of both sides is there.
    #[test]
    fn upload_in_parts() {
        rt().block_on(async {
            let (_tmp, st) = state();
            let app = app(&st);
            let (_, _, b) = call(&app, "POST", "/api/projects", &[], r#"{"name":"x"}"#).await;
            let id = v(&b)["id"].as_str().unwrap().to_string();
            let dir = st.store.project_dir(&id);
            let put = |side: &str, query: &str, name: &str, data: &'static str| {
                let uri = format!("/api/projects/{id}/files/{side}{query}");
                let app = app.clone();
                let name = name.to_string();
                async move {
                    let (code, _, b) =
                        call(&app, "PUT", &uri, &[("x-filename", &name)], data).await;
                    (code, v(&b))
                }
            };
            let on_disk = || {
                let mut names: Vec<String> = std::fs::read_dir(&dir)
                    .unwrap()
                    .flatten()
                    .map(|e| e.file_name().to_string_lossy().into_owned())
                    .filter(|n| n != "project.json")
                    .collect();
                names.sort();
                names
            };

            // The right camera: one file, as always.
            let (code, p) = put("right", "", "IMG_1.MOV", "right").await;
            assert_eq!(code, StatusCode::OK);
            assert!(p["files"]["right"].get("parts").is_none());

            // The left camera: three parts, sent in any order.
            let (code, p) = put("left", "?part=2&parts=3", "GX020042.MP4", "22").await;
            assert_eq!(code, StatusCode::OK, "{p}");
            assert_eq!(p["status"], "new");
            assert_eq!(
                p["files"]["left"],
                json!({"name": "GX020042.MP4", "sizeBytes": 2, "parts": [
                    null, {"name": "GX020042.MP4", "sizeBytes": 2}, null]})
            );
            let (_, p) = put("left", "?part=1&parts=3", "GX010042.MP4", "111").await;
            assert_eq!(p["status"], "new", "part 3 is missing");
            let (code, _, _) = call(
                &app,
                "POST",
                &format!("/api/projects/{id}/process"),
                &[],
                "",
            )
            .await;
            assert_eq!(code, StatusCode::BAD_REQUEST, "not all parts are there");
            let (_, p) = put("left", "?part=3&parts=3", "GX030042.MP4", "3").await;
            assert_eq!(p["status"], "uploaded");
            assert_eq!(p["files"]["left"]["name"], "GX010042.MP4");
            assert_eq!(p["files"]["left"]["sizeBytes"], 6);
            assert_eq!(
                on_disk(),
                ["left.001.mp4", "left.002.mp4", "left.003.mp4", "right.mov"]
            );
            assert_eq!(std::fs::read(dir.join("left.001.mp4")).unwrap(), b"111");

            // Sending one part again replaces only that part, and drops
            // everything made from the old one.
            for f in DERIVED_FILES
                .into_iter()
                .chain(["matched-left.mp4", "matched-right.mp4"])
            {
                std::fs::write(dir.join(f), b"old").unwrap();
            }
            let (_, p) = put("left", "?part=2&parts=3", "GX020042.MP4", "2222").await;
            assert_eq!(p["status"], "uploaded");
            assert_eq!(p["files"]["left"]["sizeBytes"], 8);
            assert_eq!(std::fs::read(dir.join("left.002.mp4")).unwrap(), b"2222");
            assert!(DERIVED_FILES.iter().all(|f| !dir.join(f).exists()));
            assert!(!dir.join("matched-left.mp4").exists());
            assert!(dir.join("matched-right.mp4").exists());
            std::fs::remove_file(dir.join("matched-right.mp4")).unwrap();

            // Fewer parts than before: the extra ones go.
            let (_, p) = put("left", "?part=2&parts=2", "GX020042.MP4", "22").await;
            assert_eq!(p["files"]["left"]["parts"].as_array().unwrap().len(), 2);
            assert_eq!(on_disk(), ["left.001.mp4", "left.002.mp4", "right.mov"]);

            // Swapping moves every part.
            let (code, _, b) =
                call(&app, "POST", &format!("/api/projects/{id}/swap"), &[], "").await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(
                v(&b)["files"]["right"]["parts"].as_array().unwrap().len(),
                2
            );
            assert_eq!(v(&b)["files"]["left"]["name"], "IMG_1.MOV");
            assert_eq!(on_disk(), ["left.mov", "right.001.mp4", "right.002.mp4"]);
            assert_eq!(std::fs::read(dir.join("right.001.mp4")).unwrap(), b"111");
            call(&app, "POST", &format!("/api/projects/{id}/swap"), &[], "").await;
            assert_eq!(on_disk(), ["left.001.mp4", "left.002.mp4", "right.mov"]);

            // One file again replaces all the parts; parts replace one file.
            let (_, p) = put("left", "?part=1&parts=1", "a.mp4", "one").await;
            assert!(p["files"]["left"].get("parts").is_none());
            assert_eq!(on_disk(), ["left.mp4", "right.mov"]);
            let (_, p) = put("right", "?part=1&parts=2", "GH010007.MP4", "r1").await;
            assert_eq!(p["status"], "new");
            assert_eq!(on_disk(), ["left.mp4", "right.001.mp4"]);

            // Nonsense is refused, and changes nothing.
            for query in [
                "?part=0&parts=2",
                "?part=3&parts=2",
                "?part=1",
                "?parts=2",
                "?part=x&parts=2",
            ] {
                let (code, p) = put("left", query, "a.mp4", "data").await;
                assert_eq!(code, StatusCode::BAD_REQUEST, "{query}");
                assert_eq!(p["error"], "The upload was not understood.", "{query}");
            }
            let (code, p) = put("left", "?part=1&parts=100", "a.mp4", "data").await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            assert!(p["error"].as_str().unwrap().contains("at most 99 files"));
            assert_eq!(on_disk(), ["left.mp4", "right.001.mp4"]);
        });
    }

    /// A different iPhone on each side (DESIGN.md 4.6).
    #[test]
    fn a_lens_per_phone() {
        rt().block_on(async {
            let (_tmp, st) = state();
            let app = app(&st);
            let body = json!({"name": "x", "lensId": "iphone-13-pro-max:ultra", "rightLensId": "iphone-11:ultra"});
            let (code, _, b) = call(&app, "POST", "/api/projects", &[], body.to_string()).await;
            assert_eq!(code, StatusCode::CREATED);
            assert_eq!(v(&b)["rightLensId"], "iphone-11:ultra");
            let id = v(&b)["id"].as_str().unwrap().to_string();
            let body = json!({"name": "x", "rightLensId": "Apple IPhone 11||3840x2160"});
            let (code, _, _) = call(&app, "POST", "/api/projects", &[], body.to_string()).await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            let (_, _, b) = call(&app, "POST", "/api/projects", &[], r#"{"name":"y","rightLensId":null}"#).await;
            assert_eq!(v(&b)["rightLensId"], Value::Null);

            // Changing it redoes the calibration, like the left lens.
            let uri = format!("/api/projects/{id}");
            let summary = crate::store::CalibSummary {
                confidence: 0.9,
                sync_offset_frames: 0,
                sync_offset_seconds: 0.0,
                lens: "x".into(),
            };
            st.store.update(&id, |m| m.calibration = Some(summary.clone()));
            let (_, _, b) = call(&app, "PATCH", &uri, &[], r#"{"name":"Renamed"}"#).await;
            assert!(v(&b)["calibration"].is_object(), "other changes keep it");
            let (_, _, b) =
                call(&app, "PATCH", &uri, &[], r#"{"rightLensId":"iphone-11:ultra"}"#).await;
            assert!(v(&b)["calibration"].is_object(), "the same lens keeps it");
            let (code, _, b) =
                call(&app, "PATCH", &uri, &[], r#"{"rightLensId":"iphone-12:ultra"}"#).await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(v(&b)["rightLensId"], "iphone-12:ultra");
            assert!(v(&b).get("calibration").is_none());
            st.store.update(&id, |m| m.calibration = Some(summary.clone()));
            let (_, _, b) = call(&app, "PATCH", &uri, &[], r#"{"rightLensId":null}"#).await;
            assert_eq!(v(&b)["rightLensId"], Value::Null);
            assert_eq!(v(&b)["lensId"], "iphone-13-pro-max:ultra");
            assert!(v(&b).get("calibration").is_none());
            let (code, _, _) = call(&app, "PATCH", &uri, &[], r#"{"rightLensId":"nope"}"#).await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            let (code, _, _) = call(&app, "PATCH", &uri, &[], r#"{"rightLensId":5}"#).await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
        });
    }

    /// A new video for one side drops that side's matching copy only.
    #[test]
    fn new_upload_removes_its_matching_copy() {
        rt().block_on(async {
            let (_tmp, st) = state();
            let app = app(&st);
            let (_, _, b) = call(&app, "POST", "/api/projects", &[], r#"{"name":"x"}"#).await;
            let id = v(&b)["id"].as_str().unwrap().to_string();
            let dir = st.store.project_dir(&id);
            for f in [
                "matched-left.mp4",
                "matched-left.json",
                "matched-right.mp4",
                "matched-right.json",
            ] {
                std::fs::write(dir.join(f), b"old").unwrap();
            }
            let uri = format!("/api/projects/{id}/files/left");
            let (code, _, _) = call(&app, "PUT", &uri, &[("x-filename", "a.mov")], "new").await;
            assert_eq!(code, StatusCode::OK);
            assert!(
                !dir.join("matched-left.mp4").exists() && !dir.join("matched-left.json").exists()
            );
            assert!(
                dir.join("matched-right.mp4").exists() && dir.join("matched-right.json").exists()
            );
            assert_eq!(
                crate::store::original_files(&dir, "left"),
                vec![dir.join("left.mov")]
            );
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

    /// "Mark the pitch": saved with the match, checked, removed; a new video
    /// drops it.
    #[test]
    fn pitch_outline() {
        rt().block_on(async {
            let (_tmp, st) = state();
            let app = app(&st);
            let (_, _, b) = call(&app, "POST", "/api/projects", &[], r#"{"name":"x"}"#).await;
            let id = v(&b)["id"].as_str().unwrap().to_string();
            assert_eq!(v(&b)["pitch"], Value::Null);
            let uri = format!("/api/projects/{id}/pitch");
            let body = json!({
                "points": [[0.9, -0.05], [-0.9, -0.05], [-0.8, -0.35], [0.8, -0.35]],
                "left": [[0.1, 0.4], [0.95, 0.42], [0.9, 0.95], [0.12, 0.9]],
                "right": [],
            });
            let (code, _, b) = call(&app, "PUT", &uri, &[], body.to_string()).await;
            assert_eq!(code, StatusCode::OK, "{}", String::from_utf8_lossy(&b));
            let pitch = &v(&b)["pitch"];
            assert_eq!(pitch["points"], body["points"]);
            assert_eq!(pitch["left"], body["left"]);
            assert_eq!(pitch["right"], json!([]));
            let first = pitch["id"].as_str().unwrap().to_string();
            let (_, _, b) = call(&app, "PUT", &uri, &[], body.to_string()).await;
            assert_ne!(v(&b)["pitch"]["id"], first.as_str(), "a new id per save");
            let roi = st.store.get(&id).unwrap().pitch.unwrap().field_roi();
            assert_eq!(roi.left.len(), 4);
            assert_eq!(roi.right.len(), 3, "the right camera ignores everything");

            for (bad, words) in [
                (json!({"points": [[0, 0], [1, 0]], "left": [], "right": []}), "not understood"),
                (json!({"points": [[0, 0], [1, 0], [1, 1]], "left": [], "right": []}), "does not cover"),
                (json!({"points": [[0, 0], [1, 0], [1, 1]], "left": [[0, 0], [2, 0], [0, 1]], "right": []}), "not understood"),
                (json!({"points": [[0, 0], [9, 0], [1, 1]], "left": [[0, 0], [1, 0], [0, 1]], "right": []}), "not understood"),
                (json!({"points": [[0, 0], [1, 0], [1, 1]], "left": [[0, 0], [1, 0]], "right": []}), "not understood"),
                (json!({"points": [[0, 0], [1, 0], [1, 1]]}), "not understood"),
            ] {
                let (code, _, b) = call(&app, "PUT", &uri, &[], bad.to_string()).await;
                assert_eq!(code, StatusCode::BAD_REQUEST, "{bad}");
                assert!(v(&b)["error"].as_str().unwrap().contains(words), "{bad}: {}", String::from_utf8_lossy(&b));
            }
            assert!(st.store.get(&id).unwrap().pitch.is_some(), "refused saves change nothing");

            let (code, _, b) = call(&app, "DELETE", &uri, &[], "").await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(v(&b)["pitch"], Value::Null);

            // Marked on a video that is then replaced: gone.
            call(&app, "PUT", &uri, &[], body.to_string()).await;
            let up = format!("/api/projects/{id}/files/left");
            let (_, _, b) = call(&app, "PUT", &up, &[("x-filename", "a.mp4")], "data").await;
            assert_eq!(v(&b)["pitch"], Value::Null);
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

    /// Version and update status in /api/health, the update calls (a test
    /// build never updates), and the settings (DESIGN.md 4.11).
    #[test]
    fn update_status_and_settings() {
        rt().block_on(async {
            let (tmp, st) = state();
            let app = app(&st);
            let (_, _, b) = call(&app, "GET", "/api/health", &[], "").await;
            let h = v(&b);
            assert_eq!(h["version"]["sha"], "dev");
            assert_eq!(h["version"]["date"], Value::Null);
            assert_eq!(h["version"]["number"], env!("CARGO_PKG_VERSION"));
            assert_eq!(h["update"]["state"], "disabled");
            assert_eq!(h["update"]["canUpdate"], false);
            assert!(
                h["update"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("doesn't update")
            );

            for path in ["/api/update/check", "/api/update/install"] {
                let (code, _, b) = call(&app, "POST", path, &[], "").await;
                assert_eq!(code, StatusCode::CONFLICT, "{path}");
                assert!(
                    v(&b)["error"]
                        .as_str()
                        .unwrap()
                        .contains("development copy")
                );
            }

            let (code, _, b) = call(&app, "GET", "/api/settings", &[], "").await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(v(&b)["autoUpdate"], true);
            if !cfg!(windows) {
                assert_eq!(v(&b)["startWithWindows"], Value::Null);
            }
            let (code, _, b) = call(
                &app,
                "PATCH",
                "/api/settings",
                &[],
                r#"{"autoUpdate":false}"#,
            )
            .await;
            assert_eq!(code, StatusCode::OK);
            assert_eq!(v(&b)["autoUpdate"], false);
            assert!(
                !crate::settings::SettingsStore::open(tmp.path())
                    .get()
                    .auto_update
            );
            let (_, _, b) = call(&app, "GET", "/api/health", &[], "").await;
            assert_eq!(v(&b)["update"]["auto"], false);

            let (code, _, b) = call(
                &app,
                "PATCH",
                "/api/settings",
                &[],
                r#"{"autoUpdate":"no"}"#,
            )
            .await;
            assert_eq!(code, StatusCode::BAD_REQUEST);
            assert!(v(&b)["error"].as_str().unwrap().contains("true or false"));
            if !cfg!(windows) {
                let body = r#"{"startWithWindows":true}"#;
                let (code, _, b) = call(&app, "PATCH", "/api/settings", &[], body).await;
                assert_eq!(code, StatusCode::BAD_REQUEST);
                assert!(
                    v(&b)["error"]
                        .as_str()
                        .unwrap()
                        .contains("only works on Windows")
                );
            }
            // Other web pages cannot change them.
            let evil = [("origin", "https://evil.example")];
            let body = r#"{"autoUpdate":true}"#;
            let (code, _, _) = call(&app, "PATCH", "/api/settings", &evil, body).await;
            assert_eq!(code, StatusCode::FORBIDDEN);
            let (code, _, _) = call(&app, "POST", "/api/update/install", &evil, "").await;
            assert_eq!(code, StatusCode::FORBIDDEN);
            assert!(!st.settings.get().auto_update);

            // Changes count as activity for the update's quiet time; the
            // editor's own status calls do not.
            assert_eq!(st.updater.activity.quiet_for(), None);
            call(&app, "GET", "/api/projects", &[], "").await;
            assert_eq!(st.updater.activity.quiet_for(), None);
            call(&app, "POST", "/api/projects", &[], r#"{"name":"A"}"#).await;
            assert!(st.updater.activity.quiet_for().is_some());
            assert_eq!(st.updater.activity.in_flight(), 0);
        });
    }
}
