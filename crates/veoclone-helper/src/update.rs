//! VeoClone updates itself (DESIGN.md 4.11).
//!
//! Every build made by CI knows its commit and date (`VEOCLONE_BUILD_SHA`,
//! `VEOCLONE_BUILD_DATE` at build time) and has a `version.json` next to it.
//! The rolling release `helper-latest` has a small `latest.json`
//! (`{sha, date, zipSize, zipSha256}`) next to `VeoClone-windows.zip`. On
//! start and every few hours VeoClone reads it; when it names a newer build
//! the zip is downloaded into the data folder, checked (size and SHA-256),
//! unpacked into `.veoclone-update/new` inside the VeoClone folder and, once
//! nothing is being worked on, swapped in (`swap.rs`). Then the new
//! VeoClone.exe is started with the same options plus `--updated-from`
//! (no browser tab, waits for the port) and this one ends. Any problem
//! leaves the version that runs now in place. Development builds never
//! update themselves.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::http::header::CONTENT_DISPOSITION;
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::api::{ApiError, AppState};
use crate::jobs::Jobs;
use crate::settings::SettingsStore;
use crate::{swap, unzip};

/// Where `latest.json` and the zip are published.
pub const DEFAULT_URL: &str =
    "https://github.com/rossdelport/veoclone/releases/download/helper-latest";
/// Overrides [`DEFAULT_URL`] (tests, a test release). Only `https://`, or
/// `http://` on this PC.
pub const URL_ENV: &str = "VEOCLONE_UPDATE_URL";
const ZIP_NAME: &str = "VeoClone-windows.zip";
/// The folder at the top of the zip.
const ZIP_FOLDER: &str = "VeoClone/";

/// The first check, a little after start.
const FIRST_CHECK: Duration = Duration::from_secs(10);
/// Then every few hours.
const INTERVAL: Duration = Duration::from_secs(4 * 3600);
/// After a problem (no internet, a broken download).
const RETRY: Duration = Duration::from_secs(3600);
/// An automatic install waits until nothing has been changed or worked on
/// for this long, so it does not restart VeoClone under someone's hands.
const QUIET: Duration = Duration::from_secs(10 * 60);
/// While an update is ready, how often to look whether VeoClone is idle.
const POLL: Duration = Duration::from_secs(10);
/// "Updating VeoClone…" shows this long before the restart, so open
/// editors (they ask every few seconds) can say so.
const SHOW_INSTALLING: Duration = Duration::from_secs(3);
/// How long the new version must keep running before this one ends (a
/// missing DLL or a crash at start shows within this time).
const WATCH: Duration = Duration::from_secs(5);
/// Free space wanted on top of the zip / the unpacked files.
const SPARE: u64 = 200 << 20;

/// The program's name in the VeoClone folder.
pub fn app_exe() -> String {
    format!("VeoClone{}", std::env::consts::EXE_SUFFIX)
}

/// Lock file in the VeoClone folder, created the first time an update is
/// unpacked there.
const FOLDER_LOCK: &str = ".veoclone-update.lock";

/// The VeoClone folders this program has locked for updating, held until it
/// ends: two VeoClones started from the same folder (with different ports)
/// must never update it at the same time.
static FOLDER_LOCKS: Mutex<Vec<(PathBuf, File)>> = Mutex::new(Vec::new());

/// Lock `install` for updating (true when this program holds the lock).
fn lock_folder(install: &Path) -> bool {
    let mut held = FOLDER_LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    if held.iter().any(|(p, _)| p == install) {
        return true;
    }
    let Ok(file) = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(install.join(FOLDER_LOCK))
    else {
        return false;
    };
    if file.try_lock().is_err() {
        return false;
    }
    held.push((install.to_path_buf(), file));
    true
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

/// Which build this is: the commit it was made from and that commit's date.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Build {
    /// Commit SHA, lower case; `"dev"` for a development build.
    pub sha: String,
    /// `None` for a development build.
    pub date: Option<DateTime<Utc>>,
}

fn is_hex(s: &str, len: std::ops::RangeInclusive<usize>) -> bool {
    len.contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn parse_date(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|d| d.with_timezone(&Utc))
}

impl Build {
    /// This program, as CI built it (or a development build).
    pub fn current() -> Build {
        Build::from_env(
            option_env!("VEOCLONE_BUILD_SHA"),
            option_env!("VEOCLONE_BUILD_DATE"),
        )
    }

    /// Both must be valid, else it is a development build.
    pub fn from_env(sha: Option<&str>, date: Option<&str>) -> Build {
        match (
            sha.map(str::trim).filter(|s| is_hex(s, 7..=40)),
            date.and_then(parse_date),
        ) {
            (Some(sha), Some(date)) => Build {
                sha: sha.to_ascii_lowercase(),
                date: Some(date),
            },
            _ => Build::dev(),
        }
    }

    pub fn dev() -> Build {
        Build {
            sha: "dev".into(),
            date: None,
        }
    }

    pub fn is_dev(&self) -> bool {
        self.date.is_none()
    }

    pub fn short(&self) -> &str {
        &self.sha[..self.sha.len().min(7)]
    }

    /// "version of 25 Oct 2026 (1a2b3c4)", or "development build".
    pub fn describe(&self) -> String {
        match self.date {
            Some(d) => format!("version of {} ({})", d.format("%-d %b %Y"), self.short()),
            None => "development build".into(),
        }
    }

    /// `{ sha, date, number }` for `/api/health`.
    pub fn to_json(&self) -> Value {
        json!({
            "number": env!("CARGO_PKG_VERSION"),
            "sha": self.sha,
            "date": self.date.map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        })
    }
}

/// `latest.json` of the release.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub sha: String,
    pub date: String,
    pub zip_size: u64,
    pub zip_sha256: String,
}

impl Latest {
    /// Read and check `latest.json`.
    pub fn parse(bytes: &[u8]) -> Result<Latest, String> {
        let mut l: Latest =
            serde_json::from_slice(bytes).map_err(|e| format!("latest.json: {e}"))?;
        l.sha = l.sha.trim().to_ascii_lowercase();
        l.zip_sha256 = l.zip_sha256.trim().to_ascii_lowercase();
        if !is_hex(&l.sha, 7..=40) {
            return Err(format!("latest.json: bad sha {:?}", l.sha));
        }
        if parse_date(&l.date).is_none() {
            return Err(format!("latest.json: bad date {:?}", l.date));
        }
        if !is_hex(&l.zip_sha256, 64..=64) {
            return Err("latest.json: bad zipSha256".into());
        }
        // Zip64 is not read (unzip.rs); GitHub allows 2 GB per file.
        if l.zip_size == 0 || l.zip_size >= 1 << 32 {
            return Err(format!("latest.json: bad zipSize {}", l.zip_size));
        }
        Ok(l)
    }

    fn build(&self) -> Build {
        Build {
            sha: self.sha.clone(),
            date: parse_date(&self.date),
        }
    }

    /// `{ sha, date }` for the status.
    fn to_json(&self) -> Value {
        let mut v = self.build().to_json();
        if let Some(o) = v.as_object_mut() {
            o.remove("number");
        }
        v
    }
}

/// Is `latest` a newer build than `current`? Never for a development build;
/// never an older one (a stale release does not undo a newer install).
pub fn is_newer(current: &Build, latest: &Latest) -> bool {
    match (current.date, parse_date(&latest.date)) {
        (Some(now), Some(then)) => latest.sha != current.sha && then > now,
        _ => false,
    }
}

/// SHA-256 of a file, lower-case hex.
pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        ctx.update(&buf[..n]);
    }
    Ok(hex(ctx.finish().as_ref()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Is the file at `path` the zip `latest` describes?
pub fn verify(path: &Path, latest: &Latest) -> Result<(), String> {
    let size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if size != latest.zip_size {
        return Err(format!("{size} bytes, expected {}", latest.zip_size));
    }
    let sum = sha256_file(path).map_err(|e| e.to_string())?;
    if sum != latest.zip_sha256 {
        return Err(format!("SHA-256 {sum}, expected {}", latest.zip_sha256));
    }
    Ok(())
}

/// The files and the build of a VeoClone folder (its `version.json`).
#[derive(Debug, Default, Deserialize)]
pub struct VersionFile {
    pub sha: String,
    #[serde(default)]
    pub files: Vec<String>,
}

pub fn read_version_file(dir: &Path) -> Option<VersionFile> {
    let bytes = std::fs::read(dir.join("version.json")).ok()?;
    // PowerShell may write a byte order mark.
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(&bytes);
    let mut v: VersionFile = serde_json::from_slice(bytes).ok()?;
    v.sha = v.sha.trim().to_ascii_lowercase();
    v.files.retain(|f| unzip::relative_name(f, "").is_ok());
    Some(v)
}

// ---------------------------------------------------------------------------
// Is VeoClone busy?
// ---------------------------------------------------------------------------

/// What an install has to wait for. (A trait so the tests can pretend.)
pub trait Work: Send + Sync {
    /// If no job runs or waits, stop new jobs from starting (they wait in
    /// the queue) and return true.
    fn pause_if_idle(&self) -> bool;
    /// Let jobs start again.
    fn resume(&self);
    /// Why VeoClone is busy right now, if it is: a job runs or waits, or a
    /// video is being received.
    fn busy(&self) -> Option<&'static str>;
}

/// The real thing: the job queue and the uploads in progress.
pub struct AppWork {
    pub jobs: Arc<Jobs>,
    pub uploads: Arc<Mutex<HashMap<String, usize>>>,
}

impl Work for AppWork {
    fn pause_if_idle(&self) -> bool {
        self.jobs.pause_if_idle()
    }

    fn resume(&self) {
        self.jobs.resume();
    }

    fn busy(&self) -> Option<&'static str> {
        if !self.jobs.idle() {
            Some("a match is being processed or a video is being made")
        } else if self
            .uploads
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|n| *n > 0)
        {
            Some("a video is being added")
        } else {
            None
        }
    }
}

/// Requests to the API: how many are being answered (a download of a
/// finished video counts until it is complete), and when the last change
/// was made (anything but GET).
#[derive(Default)]
pub struct Activity {
    in_flight: AtomicUsize,
    last: Mutex<Option<Instant>>,
}

impl Activity {
    pub fn touch(&self) {
        *self.last.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    }

    /// How long since the last change or job; `None`: none since start.
    pub fn quiet_for(&self) -> Option<Duration> {
        self.last
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .map(|t| t.elapsed())
    }

    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    fn begin(self: &Arc<Self>, change: bool) -> InFlight {
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        if change {
            self.touch();
        }
        InFlight {
            activity: self.clone(),
            change,
        }
    }
}

/// One request being answered.
struct InFlight {
    activity: Arc<Activity>,
    change: bool,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.activity.in_flight.fetch_sub(1, Ordering::SeqCst);
        if self.change {
            self.activity.touch();
        }
    }
}

/// A response body that counts as in flight until it is sent or dropped.
struct Counted {
    body: Body,
    _in_flight: InFlight,
}

impl http_body::Body for Counted {
    type Data = Bytes;
    type Error = axum::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<http_body::Frame<Bytes>, axum::Error>>> {
        Pin::new(&mut self.body).poll_frame(cx)
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        self.body.size_hint()
    }
}

/// Middleware: keeps [`Activity`] up to date. The editor's own status calls
/// (health, update, settings) and the editor's files do not count.
pub async fn track(State(activity): State<Arc<Activity>>, req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let counted = path.starts_with("/api/")
        && !["/api/health", "/api/update/", "/api/settings"]
            .iter()
            .any(|p| path.starts_with(p));
    if !counted {
        return next.run(req).await;
    }
    let change = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    let in_flight = activity.begin(change);
    let res = next.run(req).await;
    let download = res
        .headers()
        .get(CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.starts_with("attachment"));
    if download {
        res.map(|body| {
            Body::new(Counted {
                body,
                _in_flight: in_flight,
            })
        })
    } else {
        res
    }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdateState {
    UpToDate,
    Checking,
    Downloading,
    Ready,
    Installing,
    Failed,
    Disabled,
}

/// `update` in `/api/health`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub state: UpdateState,
    /// The newest build, once known (`{ sha, date }`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest: Option<Value>,
    /// Download progress 0..1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f64>,
    /// In plain words.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// The technical reason of a failure.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Automatic updates are on.
    pub auto: bool,
    /// This copy can update itself at all (not a development build, in its
    /// own folder).
    pub can_update: bool,
}

const DEV: &str = "This is a development copy of VeoClone. It doesn't update itself.";
const NOT_IN_FOLDER: &str = "VeoClone can't update itself because some of its files are \
                             missing from its folder. Download VeoClone again to get updates.";
const AUTO_OFF: &str = "Automatic updates are off.";
const CHECK_FAILED: &str = "VeoClone couldn't check for updates. Is this PC connected to the \
                            internet? It will try again later.";
const DOWNLOAD_FAILED: &str = "VeoClone couldn't download its update. It will try again later.";
const DAMAGED: &str = "The update didn't download properly, so VeoClone kept the version you \
                       have. It will try again later.";
const UNPACK_FAILED: &str = "VeoClone couldn't unpack its update, so it kept the version you \
                             have. It will try again later.";
const NO_SPACE: &str = "There isn't enough free disk space for VeoClone's update. Free up some \
                        space (for example by deleting old matches); it will try again later.";
const NOT_WRITABLE: &str = "VeoClone can't update itself in the folder it is in. Move the \
                            VeoClone folder to your Documents folder (not Program Files) and \
                            start it from there.";
const OTHER_COPY: &str = "Another VeoClone window started from this folder is updating it. \
                          This one tries again later.";
const READY_AUTO: &str = "Update ready — it installs when nothing is processing.";
const READY_MANUAL: &str = "Update ready. Click Install now to restart VeoClone with it.";
const INSTALLING: &str = "Updating VeoClone… it will restart in a moment.";
const INSTALL_FAILED: &str = "VeoClone couldn't install its update, so it kept the version you \
                              have. It will try again later.";
const DID_NOT_START: &str = "The new version of VeoClone didn't start, so VeoClone kept the \
                             version you have. It will try again later.";
const MIXED_UP: &str = "VeoClone couldn't finish its update and couldn't put all its files \
                        back. Please download VeoClone again (your matches are safe).";
pub const UPDATED: &str = "VeoClone updated itself to the newest version.";
const NO_UPDATE: &str = "There is no update to install yet.";

/// Why VeoClone cannot update itself from `install` (running `exe`), if it
/// cannot: a development build, or not in a VeoClone folder made by CI
/// (`version.json` of this very build next to it).
pub fn install_problem(build: &Build, install: &Path) -> Option<&'static str> {
    if build.is_dev() {
        return Some(DEV);
    }
    match read_version_file(install) {
        Some(v) if v.sha == build.sha => None,
        _ => Some(NOT_IN_FOLDER),
    }
}

/// Settings for [`Updater::new`].
pub struct Config {
    pub build: Build,
    /// The VeoClone folder (where the program is).
    pub install: PathBuf,
    pub data_dir: PathBuf,
    /// Where `latest.json` and the zip are.
    pub url: String,
    /// The options to start the new version with (they include
    /// `--updated-from`).
    pub relaunch: Vec<OsString>,
    /// Started by an update from this build.
    pub updated_from: Option<String>,
}

#[derive(Default)]
struct Asked {
    check: bool,
    install: bool,
    settings: bool,
}

/// A problem: plain words for the user, the technical reason for the log.
struct Problem {
    message: &'static str,
    detail: String,
}

fn problem(message: &'static str, detail: impl std::fmt::Display) -> Problem {
    Problem {
        message,
        detail: detail.to_string(),
    }
}

pub struct Updater {
    cfg: Config,
    /// Set when this copy can never update itself.
    cannot: Option<&'static str>,
    settings: Arc<SettingsStore>,
    work: Arc<dyn Work>,
    pub activity: Arc<Activity>,
    status: Mutex<Status>,
    /// The newest build found, while it is downloaded or ready.
    pending: Mutex<Option<Latest>>,
    asked: Mutex<Asked>,
    wake: Condvar,
    agent: ureq::Agent,
}

impl Updater {
    pub fn new(cfg: Config, settings: Arc<SettingsStore>, work: Arc<dyn Work>) -> Arc<Updater> {
        let cannot = install_problem(&cfg.build, &cfg.install);
        let auto = settings.get().auto_update;
        let (state, message) = match (cannot, auto) {
            (Some(why), _) => (UpdateState::Disabled, Some(why)),
            (None, false) => (UpdateState::Disabled, Some(AUTO_OFF)),
            (None, true) if cfg.updated_from.is_some() => (UpdateState::UpToDate, Some(UPDATED)),
            (None, true) => (UpdateState::Checking, None),
        };
        let agent = ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_response(Some(Duration::from_secs(60)))
            .user_agent(format!(
                "VeoClone/{} ({})",
                env!("CARGO_PKG_VERSION"),
                cfg.build.short()
            ))
            .build()
            .new_agent();
        Arc::new(Updater {
            status: Mutex::new(Status {
                state,
                latest: None,
                progress: None,
                message: message.map(str::to_string),
                detail: None,
                auto,
                can_update: cannot.is_none(),
            }),
            cfg,
            cannot,
            settings,
            work,
            activity: Arc::default(),
            pending: Mutex::new(None),
            asked: Mutex::new(Asked::default()),
            wake: Condvar::new(),
            agent,
        })
    }

    pub fn build(&self) -> &Build {
        &self.cfg.build
    }

    pub fn status(&self) -> Status {
        let mut s = self.lock_status().clone();
        s.auto = self.settings.get().auto_update;
        s
    }

    fn lock_status(&self) -> std::sync::MutexGuard<'_, Status> {
        self.status.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, state: UpdateState, message: Option<&str>) {
        let mut s = self.lock_status();
        s.state = state;
        s.message = message.map(str::to_string);
        s.detail = None;
        s.progress = None;
        s.latest = self
            .pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(Latest::to_json)
            .or(s.latest.take());
    }

    fn fail(&self, p: Problem) {
        log::warn!("Update: {} ({})", p.message, p.detail);
        self.set(UpdateState::Failed, Some(p.message));
        self.lock_status().detail = Some(p.detail);
    }

    fn ask(&self, f: impl FnOnce(&mut Asked)) {
        f(&mut self.asked.lock().unwrap_or_else(|e| e.into_inner()));
        self.wake.notify_all();
    }

    /// "Check for updates" (also when automatic updates are off).
    pub fn ask_check(&self) -> Result<Status, &'static str> {
        if let Some(why) = self.cannot {
            return Err(why);
        }
        if matches!(
            self.lock_status().state,
            UpdateState::UpToDate | UpdateState::Failed | UpdateState::Disabled
        ) {
            self.set(UpdateState::Checking, None);
        }
        self.ask(|a| a.check = true);
        Ok(self.status())
    }

    /// "Install now": install the update that is ready, if VeoClone is idle.
    pub fn ask_install(&self) -> Result<Status, &'static str> {
        if let Some(why) = self.cannot {
            return Err(why);
        }
        if self.lock_status().state != UpdateState::Ready {
            return Err(NO_UPDATE);
        }
        if self.work.busy().is_some() || self.activity.in_flight() > 0 {
            return Err(
                "VeoClone is busy (processing a match, making a video or adding a \
                        video). The update installs when it has finished.",
            );
        }
        self.ask(|a| a.install = true);
        Ok(self.status())
    }

    /// The automatic-updates setting changed.
    pub fn settings_changed(&self) {
        self.ask(|a| a.settings = true);
    }

    /// Start checking in the background.
    pub fn start(self: &Arc<Self>) {
        self.tidy_downloads();
        if self.cannot.is_some() {
            return;
        }
        let me = self.clone();
        std::thread::Builder::new()
            .name("veoclone-update".into())
            .spawn(move || me.run())
            .expect("spawn updater");
    }

    fn downloads(&self) -> PathBuf {
        self.cfg.data_dir.join("updates")
    }

    fn zip_path(&self, latest: &Latest) -> PathBuf {
        let short = &latest.sha[..latest.sha.len().min(12)];
        self.downloads().join(format!("VeoClone-{short}.zip"))
    }

    /// Unfinished downloads, and the zip of this very version (installed).
    fn tidy_downloads(&self) {
        let Ok(dir) = std::fs::read_dir(self.downloads()) else {
            return;
        };
        let me = self.cfg.build.sha[..self.cfg.build.sha.len().min(12)].to_string();
        for e in dir.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.ends_with(".part") || name == format!("VeoClone-{me}.zip") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }

    fn run(self: Arc<Self>) {
        let mut next_check = Instant::now() + FIRST_CHECK;
        loop {
            let ready = self.lock_status().state == UpdateState::Ready;
            let wait_until = if ready {
                next_check.min(Instant::now() + POLL)
            } else {
                next_check
            };
            let asked = {
                let mut a = self.asked.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    if a.check || a.install || a.settings {
                        break std::mem::take(&mut *a);
                    }
                    let now = Instant::now();
                    if now >= wait_until {
                        break Asked::default();
                    }
                    a = self
                        .wake
                        .wait_timeout(a, wait_until - now)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            };
            let auto = self.settings.get().auto_update;
            if asked.settings {
                let state = self.lock_status().state;
                if auto && state == UpdateState::Disabled {
                    next_check = Instant::now();
                } else if !auto
                    && matches!(
                        state,
                        UpdateState::UpToDate | UpdateState::Checking | UpdateState::Failed
                    )
                {
                    self.set(UpdateState::Disabled, Some(AUTO_OFF));
                }
                if state == UpdateState::Ready {
                    self.set_ready();
                }
            }
            let due = Instant::now() >= next_check;
            if asked.check || (auto && due) {
                let ok = self.check_and_fetch();
                next_check = Instant::now() + if ok { INTERVAL } else { RETRY };
            } else if due {
                next_check = Instant::now() + INTERVAL;
            }
            // A job counts as activity: wait the quiet time after it too.
            if self.work.busy().is_some() {
                self.activity.touch();
            }
            let quiet = self.activity.quiet_for().is_none_or(|d| d >= QUIET);
            if self.lock_status().state == UpdateState::Ready
                && (asked.install || (self.settings.get().auto_update && quiet))
            {
                self.install();
            }
        }
    }

    fn set_ready(&self) {
        let auto = self.settings.get().auto_update;
        self.set(
            UpdateState::Ready,
            Some(if auto { READY_AUTO } else { READY_MANUAL }),
        );
    }

    fn fetch_latest(&self) -> Result<Latest, String> {
        let url = format!("{}/latest.json", self.cfg.url);
        let mut res = self
            .agent
            .get(&url)
            .header("Cache-Control", "no-cache")
            .config()
            .timeout_global(Some(Duration::from_secs(60)))
            .build()
            .call()
            .map_err(|e| format!("{url}: {e}"))?;
        let bytes = res
            .body_mut()
            .with_config()
            .limit(64 * 1024)
            .read_to_vec()
            .map_err(|e| format!("{url}: {e}"))?;
        Latest::parse(&bytes)
    }

    /// Check for a newer build and get it ready. False after a problem.
    fn check_and_fetch(&self) -> bool {
        let busy_before = self.lock_status().state;
        if busy_before != UpdateState::Ready {
            self.set(UpdateState::Checking, None);
        }
        let latest = match self.fetch_latest() {
            Ok(l) => l,
            Err(e) => {
                if busy_before == UpdateState::Ready {
                    // The update already here can still be installed.
                    log::warn!("Update: could not check again: {e}");
                    return false;
                }
                self.fail(problem(CHECK_FAILED, e));
                return false;
            }
        };
        if !is_newer(&self.cfg.build, &latest) {
            *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
            self.set(UpdateState::UpToDate, None);
            self.lock_status().latest = Some(latest.to_json());
            return true;
        }
        if self.staged().as_ref() == Some(&latest) {
            *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(latest);
            self.set_ready();
            return true;
        }
        log::info!(
            "Update: {} is available (this is {})",
            latest.build().describe(),
            self.cfg.build.describe()
        );
        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = Some(latest.clone());
        match self.download_and_unpack(latest, true) {
            Ok(()) => {
                self.set_ready();
                true
            }
            Err(p) => {
                *self.pending.lock().unwrap_or_else(|e| e.into_inner()) = None;
                self.fail(p);
                false
            }
        }
    }

    /// The update that is unpacked and ready, if any.
    fn staged(&self) -> Option<Latest> {
        let work = swap::work_dir(&self.cfg.install);
        if !swap::staging_dir(&self.cfg.install).is_dir() {
            return None;
        }
        serde_json::from_slice(&std::fs::read(work.join("staged.json")).ok()?).ok()
    }

    fn download_and_unpack(&self, latest: Latest, may_retry: bool) -> Result<(), Problem> {
        let zip = self.zip_path(&latest);
        if verify(&zip, &latest).is_err() {
            let _ = std::fs::remove_file(&zip);
            match self.download(&latest, &zip) {
                Ok(()) => {}
                // The release may have changed while this was downloading
                // (latest.json and the zip are replaced one after the
                // other): look again once.
                Err(p) if may_retry && p.message == DAMAGED => {
                    if let Ok(again) = self.fetch_latest()
                        && again != latest
                    {
                        log::info!("Update: the release changed during the download");
                        if !is_newer(&self.cfg.build, &again) {
                            return Err(p);
                        }
                        *self.pending.lock().unwrap_or_else(|e| e.into_inner()) =
                            Some(again.clone());
                        return self.download_and_unpack(again, false);
                    }
                    return Err(p);
                }
                Err(p) => return Err(p),
            }
        }
        self.unpack(&latest, &zip)
    }

    fn download(&self, latest: &Latest, zip: &Path) -> Result<(), Problem> {
        let dir = self.downloads();
        std::fs::create_dir_all(&dir).map_err(|e| problem(DOWNLOAD_FAILED, e))?;
        // Only one update is kept.
        for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            let _ = std::fs::remove_file(e.path());
        }
        let need = latest.zip_size + SPARE;
        if let Ok(free) = fs4::available_space(&dir)
            && free < need
        {
            return Err(problem(
                NO_SPACE,
                format!(
                    "not enough disk space in {}: {free} free, {need} needed",
                    dir.display()
                ),
            ));
        }
        self.set(
            UpdateState::Downloading,
            Some("Downloading an update for VeoClone…"),
        );
        self.lock_status().progress = Some(0.0);
        let part = zip.with_extension("zip.part");
        let result = self.download_to(latest, &part);
        if let Err(p) = result {
            let _ = std::fs::remove_file(&part);
            return Err(p);
        }
        std::fs::rename(&part, zip).map_err(|e| problem(DOWNLOAD_FAILED, e))
    }

    fn download_to(&self, latest: &Latest, part: &Path) -> Result<(), Problem> {
        let url = format!("{}/{ZIP_NAME}", self.cfg.url);
        let res = self
            .agent
            .get(&url)
            .call()
            .map_err(|e| problem(DOWNLOAD_FAILED, format!("{url}: {e}")))?;
        let mut reader = res.into_body().into_reader();
        let mut file = File::create(part).map_err(|e| problem(DOWNLOAD_FAILED, e))?;
        let mut ctx = ring::digest::Context::new(&ring::digest::SHA256);
        let mut buf = vec![0u8; 1 << 16];
        let mut done = 0u64;
        let mut shown = 0.0;
        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|e| problem(DOWNLOAD_FAILED, format!("{url}: {e}")))?;
            if n == 0 {
                break;
            }
            done += n as u64;
            if done > latest.zip_size {
                return Err(problem(
                    DAMAGED,
                    format!("{url}: bigger than {}", latest.zip_size),
                ));
            }
            ctx.update(&buf[..n]);
            file.write_all(&buf[..n])
                .map_err(|e| problem(DOWNLOAD_FAILED, e))?;
            let progress = done as f64 / latest.zip_size as f64;
            if progress - shown >= 0.01 {
                shown = progress;
                self.lock_status().progress = Some((progress * 100.0).floor() / 100.0);
            }
        }
        file.sync_all().map_err(|e| problem(DOWNLOAD_FAILED, e))?;
        let sum = hex(ctx.finish().as_ref());
        if done != latest.zip_size || sum != latest.zip_sha256 {
            return Err(problem(
                DAMAGED,
                format!(
                    "{url}: got {done} bytes with SHA-256 {sum}, expected {} bytes with {}",
                    latest.zip_size, latest.zip_sha256
                ),
            ));
        }
        log::info!("Update: downloaded and checked {}", part.display());
        Ok(())
    }

    fn unpack(&self, latest: &Latest, zip: &Path) -> Result<(), Problem> {
        let install = &self.cfg.install;
        let work = swap::work_dir(install);
        let staging = swap::staging_dir(install);
        if let Err(e) = std::fs::create_dir_all(&work) {
            return Err(problem(
                NOT_WRITABLE,
                format!("cannot write in {} ({e})", install.display()),
            ));
        }
        if !lock_folder(install) {
            return Err(problem(OTHER_COPY, format!("{FOLDER_LOCK} is locked")));
        }
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::remove_file(work.join("staged.json"));
        let fail = |detail: String| {
            let _ = std::fs::remove_dir_all(&work);
            problem(UNPACK_FAILED, detail)
        };
        let size = File::open(zip)
            .map_err(|e| e.to_string())
            .and_then(|mut f| unzip::entries(&mut f))
            .map(|e| unzip::unpacked_size(&e))
            .map_err(|e| fail(format!("{}: {e}", zip.display())))?;
        if let Ok(free) = fs4::available_space(install)
            && free < size + SPARE
        {
            let _ = std::fs::remove_dir_all(&work);
            return Err(problem(
                NO_SPACE,
                format!(
                    "not enough disk space in {}: {free} free, {} needed",
                    install.display(),
                    size + SPARE
                ),
            ));
        }
        let files = unzip::extract(zip, ZIP_FOLDER, &staging)
            .map_err(|e| fail(format!("{}: {e}", zip.display())))?;
        if !files.iter().any(|f| *f == app_exe()) {
            return Err(fail(format!("{} is not in the update", app_exe())));
        }
        match read_version_file(&staging) {
            Some(v) if v.sha == latest.sha => {}
            other => {
                return Err(fail(format!(
                    "the update's version.json is for {:?}, expected {}",
                    other.map(|v| v.sha),
                    latest.sha
                )));
            }
        }
        let json = serde_json::to_vec_pretty(latest).unwrap_or_default();
        crate::store::write_atomic(&work.join("staged.json"), &json)
            .map_err(|e| fail(e.to_string()))?;
        log::info!(
            "Update: unpacked {} files into {}",
            files.len(),
            staging.display()
        );
        Ok(())
    }

    /// Install the update that is ready, when VeoClone is idle. Ends this
    /// program when it worked.
    fn install(&self) {
        if self.work.busy().is_some() || self.activity.in_flight() > 0 {
            return; // stays ready
        }
        if !self.work.pause_if_idle() {
            return;
        }
        self.set(UpdateState::Installing, Some(INSTALLING));
        std::thread::sleep(SHOW_INSTALLING);
        let outcome = match self.work.busy() {
            Some(_) => Ok(false),
            None if self.activity.in_flight() > 0 => Ok(false),
            None => self.swap_and_restart(),
        };
        self.work.resume();
        match outcome {
            Ok(_) => self.set_ready(), // something started meanwhile: later
            Err(p) => self.fail(p),
        }
    }

    /// Swap the files, start the new version and end this one. `Ok(false)`:
    /// something started meanwhile, everything was put back.
    fn swap_and_restart(&self) -> Result<bool, Problem> {
        let install = &self.cfg.install;
        if !lock_folder(install) {
            return Err(problem(OTHER_COPY, format!("{FOLDER_LOCK} is locked")));
        }
        let Some(latest) = self.staged() else {
            return Err(problem(INSTALL_FAILED, "the unpacked update is gone"));
        };
        let staging = swap::staging_dir(install);
        let new_files = list_files(&staging).map_err(|e| problem(INSTALL_FAILED, e))?;
        let old_files = read_version_file(install)
            .map(|v| v.files)
            .unwrap_or_default();
        let plan = swap::plan(
            install,
            &new_files,
            &old_files,
            &app_exe(),
            &self.cfg.build.sha,
            &latest.sha,
        );
        log::info!(
            "Update: installing {} ({} files)",
            latest.build().describe(),
            plan.moves.len()
        );
        swap::apply(install, &plan, &mut swap::rename_retrying)
            .map_err(|e| problem(INSTALL_FAILED, e))?;
        let undo = |why: Problem| -> Problem {
            match swap::rollback(install, &plan) {
                Ok(()) => why,
                Err(e) => problem(MIXED_UP, format!("{}; undo: {e}", why.detail)),
            }
        };

        let exe = install.join(app_exe());
        let mut child = match std::process::Command::new(&exe)
            .args(&self.cfg.relaunch)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                return Err(undo(problem(
                    DID_NOT_START,
                    format!("{}: {e}", exe.display()),
                )));
            }
        };
        let deadline = Instant::now() + WATCH;
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(undo(problem(
                    DID_NOT_START,
                    format!("{} ended at once ({status})", exe.display()),
                )));
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        if self.work.busy().is_some() || self.activity.in_flight() > 0 {
            // Someone started something: stop the new one (it only waits
            // for the port) and keep this one.
            log::info!("Update: VeoClone got busy; installing later");
            let _ = child.kill();
            let _ = child.wait();
            return match swap::rollback(install, &plan) {
                Ok(()) => Ok(false),
                Err(e) => Err(problem(MIXED_UP, e)),
            };
        }
        println!("\n  VeoClone is restarting to finish its update…\n");
        let _ = std::io::stdout().flush();
        log::info!("Update: the new version is running; this one ends");
        std::process::exit(0);
    }
}

/// Every file below `dir`, relative and `/`-separated.
fn list_files(dir: &Path) -> std::io::Result<Vec<String>> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
        for e in std::fs::read_dir(dir)? {
            let p = e?.path();
            if p.is_dir() {
                walk(root, &p, out)?;
            } else {
                let rel = p.strip_prefix(root).map_err(std::io::Error::other)?;
                let parts: Vec<String> = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect();
                out.push(parts.join("/"));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out)?;
    out.sort();
    Ok(out)
}

/// At start, before anything else uses the VeoClone folder: finish or undo
/// a swap that was in progress (DESIGN.md 4.11). The backups of a finished
/// swap are deleted in the background, as the old program may take a
/// moment to close.
pub fn recover_install(install: &Path, build: &Build) {
    if build.is_dev() || !swap::work_dir(install).exists() {
        return;
    }
    if !lock_folder(install) {
        log::warn!("Another VeoClone from this folder is updating it");
        return;
    }
    match swap::recover(install, &build.sha) {
        swap::Recovery::Nothing => {}
        swap::Recovery::RolledBack => log::warn!(
            "An update was cut short last time; the files of {} were put back",
            build.describe()
        ),
        swap::Recovery::RollbackFailed(e) => {
            log::error!("An update was cut short and could not be undone: {e}")
        }
        swap::Recovery::Finish(plan) => {
            let install = install.to_path_buf();
            std::thread::spawn(move || {
                for _ in 0..60 {
                    let left = swap::commit(&install, &plan);
                    if left.is_empty() {
                        log::info!("Update: removed the old version's files");
                        return;
                    }
                    std::thread::sleep(Duration::from_secs(2));
                }
                log::warn!("Update: could not remove some old files yet; next time");
            });
        }
    }
}

/// The update address: [`URL_ENV`] when it is safe, else [`DEFAULT_URL`].
pub fn update_url() -> String {
    match std::env::var(URL_ENV) {
        Ok(url) if url_allowed(&url) => url.trim_end_matches('/').to_string(),
        Ok(url) => {
            log::warn!("Ignoring {URL_ENV}={url}: only https:// or http:// on this PC");
            DEFAULT_URL.into()
        }
        Err(_) => DEFAULT_URL.into(),
    }
}

fn url_allowed(url: &str) -> bool {
    url.starts_with("https://")
        || [
            "http://127.0.0.1:",
            "http://localhost:",
            "http://127.0.0.1/",
            "http://localhost/",
        ]
        .iter()
        .any(|p| url.starts_with(p))
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

/// `POST /api/update/check`
pub async fn check(State(s): State<AppState>) -> Result<Response, ApiError> {
    s.updater
        .ask_check()
        .map(|status| axum::Json(status).into_response())
        .map_err(|why| ApiError::new(StatusCode::CONFLICT, why))
}

/// `POST /api/update/install`
pub async fn install(State(s): State<AppState>) -> Result<Response, ApiError> {
    s.updater
        .ask_install()
        .map(|status| (StatusCode::ACCEPTED, axum::Json(status)).into_response())
        .map_err(|why| ApiError::new(StatusCode::CONFLICT, why))
}

fn settings_json(s: &AppState) -> Value {
    json!({
        "autoUpdate": s.settings.get().auto_update,
        "startWithWindows": s.shortcuts.start_with_windows(),
    })
}

/// `GET /api/settings`
pub async fn get_settings(State(s): State<AppState>) -> Response {
    axum::Json(settings_json(&s)).into_response()
}

/// `PATCH /api/settings` `{ autoUpdate?, startWithWindows? }`
pub async fn patch_settings(State(s): State<AppState>, body: Body) -> Result<Response, ApiError> {
    let req: serde_json::Map<String, Value> = crate::api::read_json(body, 64 * 1024).await?;
    let flag = |key: &str| match req.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("{key} must be true or false."),
        )),
    };
    let (auto, startup) = (flag("autoUpdate")?, flag("startWithWindows")?);
    if let Some(on) = startup {
        if s.shortcuts.start_with_windows().is_none() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "Starting with Windows only works on Windows.",
            ));
        }
        let shortcuts = s.shortcuts.clone();
        tokio::task::spawn_blocking(move || shortcuts.set_start_with_windows(on))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
            .map_err(|e| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    if on {
                        "VeoClone couldn't add itself to the programs that start with Windows."
                    } else {
                        "VeoClone couldn't remove itself from the programs that start with Windows."
                    },
                )
                .detail(e)
            })?;
    }
    if let Some(on) = auto {
        s.settings.update(|st| st.auto_update = on).map_err(|e| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "VeoClone couldn't save the setting.",
            )
            .detail(e)
        })?;
        s.updater.settings_changed();
    }
    Ok(axum::Json(settings_json(&s)).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    fn latest(sha: &str, date: &str) -> Latest {
        Latest {
            sha: sha.into(),
            date: date.into(),
            zip_size: 10,
            zip_sha256: "0".repeat(64),
        }
    }

    #[test]
    fn build_identity() {
        let b = Build::from_env(
            Some("A1B2C3D4E5F60718293a4b5c6d7e8f9012345678"),
            Some("2026-10-25T09:30:00Z"),
        );
        assert!(!b.is_dev());
        assert_eq!(b.sha, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
        assert_eq!(b.short(), "a1b2c3d");
        assert_eq!(b.describe(), "version of 25 Oct 2026 (a1b2c3d)");
        assert_eq!(b.to_json()["date"], "2026-10-25T09:30:00Z");
        // Offsets are fine; anything missing or odd is a development build.
        assert_eq!(
            Build::from_env(Some("abcdef0"), Some("2026-10-25T11:30:00+02:00")).date,
            b.date
        );
        for (sha, date) in [
            (None, Some("2026-10-25T09:30:00Z")),
            (Some("abcdef0"), None),
            (Some(""), Some("2026-10-25T09:30:00Z")),
            (Some("dev"), Some("2026-10-25T09:30:00Z")),
            (Some("abcdef0"), Some("yesterday")),
        ] {
            let b = Build::from_env(sha, date);
            assert!(b.is_dev(), "{sha:?} {date:?}");
            assert_eq!(b.to_json()["sha"], "dev");
            assert_eq!(b.to_json()["date"], Value::Null);
        }
        // This test build has no CI identity.
        if option_env!("VEOCLONE_BUILD_SHA").is_none() {
            assert!(Build::current().is_dev());
        }
    }

    #[test]
    fn version_comparison() {
        let now = Build::from_env(Some("aaaaaaa"), Some("2026-10-25T09:30:00Z"));
        assert!(is_newer(&now, &latest("bbbbbbb", "2026-10-26T08:00:00Z")));
        assert!(is_newer(&now, &latest("bbbbbbb", "2026-10-25T09:30:01Z")));
        // The same build, an older one, or the same time: no.
        assert!(!is_newer(&now, &latest("aaaaaaa", "2026-10-26T08:00:00Z")));
        assert!(!is_newer(&now, &latest("bbbbbbb", "2026-10-24T08:00:00Z")));
        assert!(!is_newer(&now, &latest("bbbbbbb", "2026-10-25T09:30:00Z")));
        assert!(!is_newer(&now, &latest("bbbbbbb", "nonsense")));
        // A development build never updates.
        assert!(!is_newer(
            &Build::dev(),
            &latest("bbbbbbb", "2030-01-01T00:00:00Z")
        ));
    }

    #[test]
    fn latest_json() {
        let ok = br#"{"sha":"0123456789ABCDEF0123456789abcdef01234567","date":"2026-10-25T09:30:00Z",
            "zipSize":123456789,"zipSha256":"E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855",
            "somethingNew":true}"#;
        let l = Latest::parse(ok).unwrap();
        assert_eq!(l.sha, "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(l.zip_size, 123_456_789);
        assert!(l.zip_sha256.starts_with("e3b0c442"));
        assert_eq!(l.to_json()["date"], "2026-10-25T09:30:00Z");
        assert!(l.to_json().get("number").is_none());
        let bad = [
            &br#"{"sha":"xyz","date":"2026-10-25T09:30:00Z","zipSize":1,"zipSha256":"00"}"#[..],
            br#"{"sha":"abcdef0","date":"2026-10-25","zipSize":1,"zipSha256":"00"}"#,
            br#"{"sha":"abcdef0","date":"2026-10-25T09:30:00Z","zipSize":0,"zipSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}"#,
            br#"{"sha":"abcdef0","date":"2026-10-25T09:30:00Z","zipSize":5000000000,"zipSha256":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}"#,
            br#"{"sha":"abcdef0","date":"2026-10-25T09:30:00Z","zipSize":1,"zipSha256":"e3b0"}"#,
            br#"{"sha":"abcdef0","date":"2026-10-25T09:30:00Z"}"#,
            b"<html>Not Found</html>",
        ];
        for b in bad {
            assert!(Latest::parse(b).is_err(), "{}", String::from_utf8_lossy(b));
        }
    }

    #[test]
    fn checksums() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("z");
        std::fs::write(&f, b"").unwrap();
        assert_eq!(
            sha256_file(&f).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        std::fs::write(&f, b"abc").unwrap();
        let mut l = latest("abcdef0", "2026-10-25T09:30:00Z");
        l.zip_size = 3;
        l.zip_sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into();
        assert_eq!(verify(&f, &l), Ok(()));
        std::fs::write(&f, b"abd").unwrap();
        assert!(verify(&f, &l).unwrap_err().contains("SHA-256"));
        std::fs::write(&f, b"abcd").unwrap();
        assert!(verify(&f, &l).unwrap_err().contains("bytes"));
        assert!(verify(&tmp.path().join("missing"), &l).is_err());
    }

    #[test]
    fn version_files_and_where_updates_work() {
        let tmp = tempfile::tempdir().unwrap();
        let b = Build::from_env(Some("abcdef0"), Some("2026-10-25T09:30:00Z"));
        assert_eq!(install_problem(&Build::dev(), tmp.path()), Some(DEV));
        assert_eq!(install_problem(&b, tmp.path()), Some(NOT_IN_FOLDER));
        // PowerShell's version.json, with a byte order mark.
        std::fs::write(
            tmp.path().join("version.json"),
            b"\xEF\xBB\xBF{\"sha\":\"ABCDEF0\",\"date\":\"x\",\"files\":[\"VeoClone.exe\",\"web/index.html\",\"../evil\"]}",
        )
        .unwrap();
        assert_eq!(install_problem(&b, tmp.path()), None);
        let v = read_version_file(tmp.path()).unwrap();
        assert_eq!(v.files, ["VeoClone.exe", "web/index.html"]);
        let other = Build::from_env(Some("1234567"), Some("2026-10-25T09:30:00Z"));
        assert_eq!(install_problem(&other, tmp.path()), Some(NOT_IN_FOLDER));
    }

    #[test]
    fn update_addresses() {
        assert!(url_allowed("https://example.com/x"));
        assert!(url_allowed("http://127.0.0.1:8000/rel"));
        assert!(url_allowed("http://localhost/rel"));
        assert!(!url_allowed("http://example.com/x"));
        assert!(!url_allowed("http://127.0.0.1.evil.com/x"));
        assert!(!url_allowed("file:///C:/x"));
    }

    /// Pretend work: busy or not.
    #[derive(Default)]
    struct FakeWork {
        busy: AtomicBool,
        paused: AtomicBool,
        pauses: AtomicUsize,
    }

    impl Work for FakeWork {
        fn pause_if_idle(&self) -> bool {
            if self.busy.load(Ordering::SeqCst) {
                return false;
            }
            self.pauses.fetch_add(1, Ordering::SeqCst);
            self.paused.store(true, Ordering::SeqCst);
            true
        }
        fn resume(&self) {
            self.paused.store(false, Ordering::SeqCst);
        }
        fn busy(&self) -> Option<&'static str> {
            self.busy.load(Ordering::SeqCst).then_some("a job")
        }
    }

    fn updater(install: &Path, data: &Path, work: Arc<FakeWork>) -> Arc<Updater> {
        Updater::new(
            Config {
                build: Build::from_env(Some("aaaaaaa"), Some("2026-10-25T09:30:00Z")),
                install: install.to_path_buf(),
                data_dir: data.to_path_buf(),
                url: "http://127.0.0.1:9/none".into(),
                relaunch: vec![],
                updated_from: None,
            },
            Arc::new(SettingsStore::open(data)),
            work,
        )
    }

    /// Never during a job: with a job (or an upload, or a request being
    /// answered) the update stays ready and nothing in the folder changes.
    #[test]
    fn never_installs_while_busy() {
        let tmp = tempfile::tempdir().unwrap();
        let install = tmp.path().join("VeoClone");
        std::fs::create_dir_all(swap::staging_dir(&install)).unwrap();
        std::fs::write(
            install.join("version.json"),
            br#"{"sha":"aaaaaaa","files":["VeoClone"]}"#,
        )
        .unwrap();
        std::fs::write(install.join(app_exe()), b"old").unwrap();
        std::fs::write(swap::staging_dir(&install).join(app_exe()), b"new").unwrap();
        let work = Arc::new(FakeWork::default());
        let u = updater(&install, tmp.path(), work.clone());
        assert!(u.status().can_update);

        // No update yet.
        assert_eq!(u.ask_install().unwrap_err(), NO_UPDATE);

        u.set_ready();
        work.busy.store(true, Ordering::SeqCst);
        assert!(u.ask_install().unwrap_err().contains("busy"));
        u.install();
        assert_eq!(u.status().state, UpdateState::Ready);
        assert_eq!(work.pauses.load(Ordering::SeqCst), 0);
        assert_eq!(std::fs::read(install.join(app_exe())).unwrap(), b"old");

        // A request being answered (e.g. a finished video downloading).
        work.busy.store(false, Ordering::SeqCst);
        let request = u.activity.begin(false);
        assert!(u.ask_install().is_err());
        u.install();
        assert_eq!(u.status().state, UpdateState::Ready);
        assert_eq!(work.pauses.load(Ordering::SeqCst), 0);
        drop(request);
        assert_eq!(u.activity.in_flight(), 0);

        // A job that starts while "Updating…" shows: put off, jobs resumed.
        let w = work.clone();
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            w.busy.store(true, Ordering::SeqCst);
        });
        u.install();
        t.join().unwrap();
        assert_eq!(work.pauses.load(Ordering::SeqCst), 1);
        assert!(!work.paused.load(Ordering::SeqCst));
        assert_eq!(u.status().state, UpdateState::Ready);
        assert_eq!(std::fs::read(install.join(app_exe())).unwrap(), b"old");
        assert!(!install.join(format!("{}.old", app_exe())).exists());

        // Changes count as activity, GETs don't; the quiet time starts after.
        let a = Arc::new(Activity::default());
        assert_eq!(a.quiet_for(), None);
        drop(a.begin(false));
        assert_eq!(a.quiet_for(), None);
        drop(a.begin(true));
        assert!(a.quiet_for().unwrap() < QUIET);
    }

    #[test]
    fn development_builds_never_update() {
        let tmp = tempfile::tempdir().unwrap();
        let u = Updater::new(
            Config {
                build: Build::dev(),
                install: tmp.path().to_path_buf(),
                data_dir: tmp.path().to_path_buf(),
                url: DEFAULT_URL.into(),
                relaunch: vec![],
                updated_from: None,
            },
            Arc::new(SettingsStore::open(tmp.path())),
            Arc::new(FakeWork::default()),
        );
        let s = u.status();
        assert_eq!(s.state, UpdateState::Disabled);
        assert!(!s.can_update);
        assert_eq!(u.ask_check().unwrap_err(), DEV);
        assert_eq!(u.ask_install().unwrap_err(), DEV);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["state"], "disabled");
        assert_eq!(json["canUpdate"], false);
        assert!(json.get("latest").is_none());
    }

    /// Two VeoClones from the same folder never update it at once.
    #[test]
    fn one_update_per_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let other = std::fs::File::create(tmp.path().join(FOLDER_LOCK)).unwrap();
        other.try_lock().unwrap();
        assert!(!lock_folder(tmp.path()));
        drop(other);
        assert!(lock_folder(tmp.path()));
        assert!(lock_folder(tmp.path()), "held until VeoClone ends");
        let again = std::fs::OpenOptions::new()
            .write(true)
            .open(tmp.path().join(FOLDER_LOCK))
            .unwrap();
        assert!(again.try_lock().is_err());
    }

    #[test]
    fn lists_files() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(tmp.path().join("web/assets")).unwrap();
        std::fs::write(tmp.path().join("web/assets/a.js"), "").unwrap();
        std::fs::write(tmp.path().join("VeoClone.exe"), "").unwrap();
        assert_eq!(
            list_files(tmp.path()).unwrap(),
            ["VeoClone.exe", "web/assets/a.js"]
        );
    }

    /// A download of a finished video counts as in flight until the last
    /// byte is sent (an update must not cut it off); other answers only
    /// while they are being made.
    #[test]
    fn downloads_count_until_sent() {
        use axum::routing::get;
        use tower::ServiceExt;
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let activity = Arc::new(Activity::default());
            let app = axum::Router::new()
                .route(
                    "/api/file",
                    get(|| async { ([(CONTENT_DISPOSITION, "attachment")], "video bytes") }),
                )
                .route("/api/plain", get(|| async { "x" }))
                .route("/api/health", get(|| async { "ok" }))
                .layer(axum::middleware::from_fn_with_state(
                    activity.clone(),
                    track,
                ));
            let req = |uri: &str| {
                axum::http::Request::builder()
                    .uri(uri)
                    .body(Body::empty())
                    .unwrap()
            };
            let res = app.clone().oneshot(req("/api/file")).await.unwrap();
            assert_eq!(activity.in_flight(), 1);
            assert_eq!(
                http_body::Body::size_hint(res.body()).exact(),
                Some(11),
                "the length is kept"
            );
            let bytes = axum::body::to_bytes(res.into_body(), 1000).await.unwrap();
            assert_eq!(&bytes[..], b"video bytes");
            assert_eq!(activity.in_flight(), 0);
            let res = app.clone().oneshot(req("/api/plain")).await.unwrap();
            assert_eq!(activity.in_flight(), 0);
            drop(res);
            app.clone().oneshot(req("/api/health")).await.unwrap();
            assert_eq!(activity.quiet_for(), None, "GETs are not changes");
        });
    }

    /// A tiny web server for the tests: path -> body (404 otherwise).
    fn serve(files: Arc<Mutex<HashMap<String, Vec<u8>>>>) -> String {
        use std::io::BufRead;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    continue;
                }
                let path = line.split(' ').nth(1).unwrap_or("").to_string();
                loop {
                    let mut h = String::new();
                    if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                        break;
                    }
                }
                let mut out = stream;
                let body = files.lock().unwrap().get(&path).cloned();
                let (status, body) = match body {
                    Some(b) => ("200 OK", b),
                    None => ("404 Not Found", b"Not Found".to_vec()),
                };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = out.write_all(head.as_bytes());
                let _ = out.write_all(&body);
            }
        });
        format!("http://127.0.0.1:{port}/rel")
    }

    /// A release with `zip` and a latest.json describing `described`.
    fn publish(
        files: &Mutex<HashMap<String, Vec<u8>>>,
        sha: &str,
        date: &str,
        zip: &[u8],
        described: &[u8],
    ) -> Latest {
        let l = Latest {
            sha: sha.into(),
            date: date.into(),
            zip_size: described.len() as u64,
            zip_sha256: hex(ring::digest::digest(&ring::digest::SHA256, described).as_ref()),
        };
        let mut f = files.lock().unwrap();
        f.insert("/rel/latest.json".into(), serde_json::to_vec(&l).unwrap());
        f.insert(format!("/rel/{ZIP_NAME}"), zip.to_vec());
        l
    }

    fn release_zip(sha: &str) -> Vec<u8> {
        let version = format!(
            r#"{{"sha":"{sha}","files":["{}","version.json"]}}"#,
            app_exe()
        );
        let exe = format!("VeoClone/{}", app_exe());
        crate::unzip::testzip::make(
            &[
                (exe.as_str(), b"new program", true),
                ("VeoClone/version.json", version.as_bytes(), false),
                ("VeoClone/web/index.html", b"<html>", false),
            ],
            true,
        )
    }

    /// Check, download, verify and unpack against a pretend release; a
    /// damaged download, a wrong zip, no release and an older release are
    /// all refused and leave the VeoClone folder as it was.
    #[test]
    fn checks_downloads_verifies_and_unpacks() {
        let tmp = tempfile::tempdir().unwrap();
        let install = tmp.path().join("VeoClone");
        let data = tmp.path().join("data");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(
            install.join("version.json"),
            format!(
                r#"{{"sha":"aaaaaaa","files":["{}","version.json"]}}"#,
                app_exe()
            ),
        )
        .unwrap();
        std::fs::write(install.join(app_exe()), b"old program").unwrap();
        let before = list_files(&install).unwrap();
        let files: Arc<Mutex<HashMap<String, Vec<u8>>>> = Arc::default();
        let url = serve(files.clone());
        let u = Updater::new(
            Config {
                build: Build::from_env(Some("aaaaaaa"), Some("2026-10-25T09:30:00Z")),
                install: install.clone(),
                data_dir: data.clone(),
                url,
                relaunch: vec![],
                updated_from: None,
            },
            Arc::new(SettingsStore::open(&data)),
            Arc::new(FakeWork::default()),
        );
        let untouched = || {
            let mut now = list_files(&install).unwrap();
            now.retain(|f| f != FOLDER_LOCK);
            assert_eq!(now, before);
            assert_eq!(
                std::fs::read(install.join(app_exe())).unwrap(),
                b"old program"
            );
            assert!(!swap::staging_dir(&install).exists());
        };

        // No release yet.
        assert!(!u.check_and_fetch());
        let s = u.status();
        assert_eq!(
            (s.state, s.message.as_deref()),
            (UpdateState::Failed, Some(CHECK_FAILED))
        );
        assert!(s.detail.unwrap().contains("404"));
        untouched();

        // An older (or the same) build: up to date.
        let zip = release_zip("bbbbbbb");
        publish(&files, "bbbbbbb", "2026-10-20T00:00:00Z", &zip, &zip);
        assert!(u.check_and_fetch());
        let s = u.status();
        assert_eq!(s.state, UpdateState::UpToDate);
        assert_eq!(s.latest.unwrap()["sha"], "bbbbbbb");
        untouched();

        // latest.json describes another zip: damaged, nothing unpacked.
        let mut other = zip.clone();
        other.push(0);
        publish(&files, "bbbbbbb", "2026-10-26T00:00:00Z", &zip, &other);
        assert!(!u.check_and_fetch());
        let s = u.status();
        assert_eq!(
            (s.state, s.message.as_deref()),
            (UpdateState::Failed, Some(DAMAGED))
        );
        untouched();
        assert_eq!(std::fs::read_dir(data.join("updates")).unwrap().count(), 0);

        // The right zip, but of another build than latest.json says.
        let wrong = release_zip("ccccccc");
        publish(&files, "bbbbbbb", "2026-10-26T00:00:00Z", &wrong, &wrong);
        assert!(!u.check_and_fetch());
        assert_eq!(u.status().message.as_deref(), Some(UNPACK_FAILED));
        untouched();

        // The real thing.
        let latest = publish(&files, "bbbbbbb", "2026-10-26T00:00:00Z", &zip, &zip);
        assert!(u.check_and_fetch());
        let s = u.status();
        assert_eq!(
            (s.state, s.message.as_deref()),
            (UpdateState::Ready, Some(READY_AUTO))
        );
        assert_eq!(s.latest.unwrap()["date"], "2026-10-26T00:00:00Z");
        assert_eq!(u.staged(), Some(latest.clone()));
        let staging = swap::staging_dir(&install);
        assert_eq!(
            list_files(&staging).unwrap(),
            [app_exe().as_str(), "version.json", "web/index.html"]
        );
        assert_eq!(
            std::fs::read(staging.join(app_exe())).unwrap(),
            b"new program"
        );
        assert_eq!(
            std::fs::read(install.join(app_exe())).unwrap(),
            b"old program"
        );
        assert!(u.zip_path(&latest).is_file());
        // Checking again re-uses it without downloading.
        files.lock().unwrap().remove(&format!("/rel/{ZIP_NAME}"));
        assert!(u.check_and_fetch());
        assert_eq!(u.status().state, UpdateState::Ready);

        // Automatic updates off: says so, and waits for "Install now".
        u.settings.update(|s| s.auto_update = false).unwrap();
        u.set_ready();
        assert_eq!(u.status().message.as_deref(), Some(READY_MANUAL));
        assert!(!u.status().auto);
    }
}
