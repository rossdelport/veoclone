//! VeoClone helper: a small local web server that keeps the user's matches
//! on disk and runs the heavy work (calibration, AI tracking, export) with
//! the Reco libraries. The editor (web/) talks to it over HTTP.

mod ai;
mod api;
mod brain;
mod calib;
mod export;
mod jobs;
mod logging;
mod media;
mod process;
mod report;
mod seen;
mod settings;
mod shortcuts;
mod store;
mod swap;
mod unzip;
mod update;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use clap::{CommandFactory, FromArgMatches, Parser};

use crate::api::{AppState, GpuInfo, HelperInfo};
use crate::jobs::{Context, Jobs};
use crate::settings::SettingsStore;
use crate::shortcuts::Shortcuts;
use crate::store::Store;
use crate::update::{AppWork, Build, Updater};

#[derive(Parser, Debug)]
#[command(name = "veoclone-helper", about = "VeoClone helper (local server)")]
struct Args {
    /// Port to listen on (127.0.0.1 only).
    #[arg(long, default_value_t = 47863)]
    port: u16,
    /// Where matches are stored (default: env VEOCLONE_HOME, else Videos/VeoClone).
    #[arg(long)]
    data_dir: Option<PathBuf>,
    /// Folder with the editor's web files (default: web/ next to the program).
    #[arg(long)]
    web_dir: Option<PathBuf>,
    /// AI model (default: env VEOCLONE_MODEL, else models/yolo26n.onnx next to the program).
    #[arg(long)]
    model: Option<PathBuf>,
    /// Extra web origin allowed to use the helper (can be repeated).
    #[arg(long = "allow-origin")]
    allow_origin: Vec<String>,
    /// Do not open the browser on start.
    #[arg(long)]
    no_open: bool,
    /// Minimise this window on start ("Start VeoClone when Windows starts").
    #[arg(long)]
    minimized: bool,
    /// Started by an update of this build: no new browser tab (the editor
    /// that is open reconnects), and wait for the old copy to free the port.
    /// Every future version must accept it (DESIGN.md 4.11).
    #[arg(long, hide = true, value_name = "BUILD")]
    updated_from: Option<String>,
    /// Developers: run the AI camera again from an AI report (the zip the
    /// editor saves), print what came out as JSON and exit (no server).
    /// See scripts/ai_report.py.
    #[arg(long, value_name = "ZIP")]
    ai_report: Option<PathBuf>,
    /// With --ai-report: write the camera path and the ball track as CSV.
    #[arg(long, value_name = "CSV", requires = "ai_report")]
    csv: Option<PathBuf>,
    /// With --ai-report: a JSON file of brain settings to change.
    #[arg(long, value_name = "JSON", requires = "ai_report")]
    brain_config: Option<PathBuf>,
    /// With --ai-report: where the ball really was (CSV frame,camera,x,y).
    #[arg(long, value_name = "CSV", requires = "ai_report")]
    truth: Option<PathBuf>,
    /// With --ai-report: another camera style (broadcast, action, frame_all, ball).
    #[arg(long, value_name = "STYLE", requires = "ai_report")]
    style: Option<String>,
}

/// `--ai-report`: the developers' tool (crate::report::tool).
fn ai_report_tool(args: &Args) -> ! {
    let run = || -> Result<serde_json::Value, String> {
        let style = match &args.style {
            Some(s) => Some(
                serde_json::from_value(serde_json::Value::String(s.clone()))
                    .map_err(|_| format!("unknown style {s}"))?,
            ),
            None => None,
        };
        report::tool(&report::ToolArgs {
            report: args.ai_report.clone().unwrap_or_default(),
            csv: args.csv.clone(),
            brain_config: args.brain_config.clone(),
            truth: args.truth.clone(),
            style,
        })
    };
    match run() {
        Ok(out) => {
            println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
            std::process::exit(0)
        }
        Err(e) => {
            eprintln!("veoclone-helper --ai-report: {e}");
            std::process::exit(2)
        }
    }
}

/// `--version`: the version number and the build.
fn version_text(build: &Build) -> String {
    match build.date {
        Some(date) => format!(
            "{} (build {}, {})",
            env!("CARGO_PKG_VERSION"),
            build.short(),
            date.format("%-d %b %Y")
        ),
        None => format!("{} (development build)", env!("CARGO_PKG_VERSION")),
    }
}

/// The options to start the new version with after an update: the same
/// as this run's, plus `--updated-from <this build>`. Not `--minimized`: the
/// new version uses the same window, which the user may have opened since.
fn relaunch_args(args: impl Iterator<Item = OsString>, from: &str) -> Vec<OsString> {
    let mut out = Vec::new();
    let mut args = args.peekable();
    while let Some(a) = args.next() {
        if a == "--updated-from" {
            args.next();
            continue;
        }
        if a.to_string_lossy().starts_with("--updated-from=") || a == "--minimized" {
            continue;
        }
        out.push(a);
    }
    out.push("--updated-from".into());
    out.push(from.into());
    out
}

/// Try `f` until it works, for up to `patience` (none: once).
fn retry<T, E>(patience: Option<Duration>, mut f: impl FnMut() -> Result<T, E>) -> Result<T, E> {
    let start = Instant::now();
    loop {
        match f() {
            Err(_) if patience.is_some_and(|p| start.elapsed() < p) => {
                std::thread::sleep(Duration::from_millis(250));
            }
            r => return r,
        }
    }
}

/// Where matches are stored: `--data-dir`, else env `VEOCLONE_HOME`, else
/// `Videos/VeoClone`. When OneDrive backs up the Videos folder (it would
/// upload tens of gigabytes per match), or Videos cannot be used (Windows
/// Controlled Folder Access), `<home>/VeoClone` is used instead, unless
/// matches are already stored in Videos.
fn data_dir(arg: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = arg.or_else(|| std::env::var_os("VEOCLONE_HOME").map(PathBuf::from)) {
        return dir;
    }
    let home = dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("VeoClone");
    let onedrive: Vec<OsString> = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
        .into_iter()
        .filter_map(std::env::var_os)
        .collect();
    match dirs::video_dir().map(|v| v.join("VeoClone")) {
        Some(videos) if videos.is_dir() => videos,
        Some(videos)
            if !inside_any(&videos, &onedrive) && std::fs::create_dir_all(&videos).is_ok() =>
        {
            videos
        }
        _ => home,
    }
}

/// Is `path` inside one of the `folders` (ignoring upper/lower case, as
/// Windows does)?
fn inside_any(path: &Path, folders: &[OsString]) -> bool {
    let lower = |p: &Path| PathBuf::from(p.to_string_lossy().to_lowercase());
    folders
        .iter()
        .filter(|f| !f.is_empty())
        .any(|f| lower(path).starts_with(lower(Path::new(f))))
}

/// Hold `<data>/veoclone.lock` while VeoClone runs, so a second copy
/// started with another `--port` cannot use the same folder.
fn lock_folder(data: &Path) -> Result<std::fs::File, std::fs::TryLockError> {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data.join("veoclone.lock"))
        .map_err(std::fs::TryLockError::Error)?;
    file.try_lock()?;
    Ok(file)
}

/// Reco's audio sync runs `ffmpeg` by name, so make the bundled copy next to
/// this program win over anything else on PATH.
fn put_exe_dir_on_path() {
    let Some(dir) = media::exe_dir() else { return };
    let mut paths = vec![dir];
    if let Some(old) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&old));
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        // SAFETY: called first thing in main, before any other thread exists.
        unsafe { std::env::set_var("PATH", joined) };
    }
}

/// Keep the message on screen for a moment before the console closes.
fn exit_with(message: &str) -> ! {
    eprintln!("\n  {message}\n");
    std::thread::sleep(std::time::Duration::from_secs(15));
    std::process::exit(1);
}

fn main() {
    let build = Build::current();
    let version: &'static str = Box::leak(version_text(&build).into_boxed_str());
    let args = Args::from_arg_matches(&Args::command().version(version).get_matches())
        .unwrap_or_else(|e| e.exit());
    if args.ai_report.is_some() {
        ai_report_tool(&args);
    }
    if args.minimized {
        shortcuts::minimize_console();
    }
    put_exe_dir_on_path();
    logging::init();
    let url = format!("http://127.0.0.1:{}/", args.port);
    // After an update the old copy is still closing: wait for it.
    let patience = args.updated_from.as_ref().map(|_| Duration::from_secs(60));
    let open_browser = !args.no_open && args.updated_from.is_none();

    // One VeoClone at a time. The port is taken before anything else: a
    // second copy must not tidy up the folder the first one is working in.
    let listener = match retry(patience, || {
        std::net::TcpListener::bind(("127.0.0.1", args.port))
    }) {
        Ok(l) => l,
        Err(e) => {
            if open_browser {
                let _ = open::that_detached(&url);
            }
            exit_with(&format!(
                "VeoClone is already running (or another program uses port {}). You can \
                 close this window. ({e})",
                args.port
            ));
        }
    };

    let data = data_dir(args.data_dir);
    let data = std::path::absolute(&data).unwrap_or(data);
    if let Err(e) = std::fs::create_dir_all(&data) {
        exit_with(&format!(
            "VeoClone could not create its folder {} ({e}).",
            data.display()
        ));
    }
    let _lock = match retry(patience, || lock_folder(&data)) {
        Ok(file) => Some(file),
        Err(std::fs::TryLockError::WouldBlock) => exit_with(&format!(
            "VeoClone is already running and using the folder {}. You can close this window.",
            data.display()
        )),
        Err(std::fs::TryLockError::Error(e)) => {
            log::warn!("Could not lock {}: {e}", data.display());
            None
        }
    };
    // Finish or undo an update that was in progress (DESIGN.md 4.11).
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from(update::app_exe()));
    let install = exe
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    update::recover_install(&install, &build);
    let store = match Store::open(&data) {
        Ok(s) => Arc::new(s),
        Err(e) => exit_with(&format!(
            "VeoClone could not open its folder {} ({e}).",
            data.display()
        )),
    };
    let tools = media::Tools::find();
    if tools.ffmpeg.is_none() || tools.ffprobe.is_none() {
        log::warn!("ffmpeg/ffprobe not found next to the helper or on PATH");
    }
    let model_arg = args
        .model
        .or_else(|| std::env::var_os("VEOCLONE_MODEL").map(PathBuf::from));
    let model = ai::find_model(model_arg.as_deref());

    let info = Arc::new(HelperInfo {
        data_dir: data.clone(),
        tools: tools.clone(),
        gpu: Mutex::new(GpuInfo {
            name: String::new(),
            backend: String::new(),
        }),
        ai: Mutex::new(None),
        model: model.clone(),
    });
    // Slow checks (GPU, AI runtime) run in the background so the editor
    // can connect straight away.
    let probe_info = info.clone();
    std::thread::spawn(move || {
        let gpu = match reco_core::gpu::GpuContext::new_blocking() {
            Ok(g) => GpuInfo {
                name: g.gpu_name().to_string(),
                backend: g.backend_name().to_string(),
            },
            Err(e) => {
                log::warn!("No usable graphics card: {e}");
                GpuInfo {
                    name: "No graphics card found".into(),
                    backend: "none".into(),
                }
            }
        };
        log::info!("Graphics card: {} ({})", gpu.name, gpu.backend);
        *probe_info.gpu.lock().unwrap() = gpu;
        let ai = ai::status(probe_info.model.as_deref());
        log::info!(
            "AI tracking: {}",
            if ai.available {
                ai.provider.as_str()
            } else {
                "not available"
            }
        );
        *probe_info.ai.lock().unwrap() = Some(ai);
    });

    let jobs = Jobs::start(Context {
        store: store.clone(),
        tools,
        model,
    });
    let uploads: Arc<Mutex<HashMap<String, usize>>> = Default::default();
    let settings = Arc::new(SettingsStore::open(&data));
    let shortcuts = Arc::new(Shortcuts::new(exe.clone()));
    if !build.is_dev() {
        // Shortcuts follow the folder when it moves; the Start menu one is
        // made once (COM takes a moment: not in the way of starting).
        let (shortcuts, settings) = (shortcuts.clone(), settings.clone());
        std::thread::spawn(move || {
            let first = !settings.get().start_menu_done;
            if shortcuts.refresh(first)
                && first
                && let Err(e) = settings.update(|s| s.start_menu_done = true)
            {
                log::warn!("Could not save the settings: {e}");
            }
        });
    }
    let updater = Updater::new(
        update::Config {
            build: build.clone(),
            install,
            data_dir: data.clone(),
            url: update::update_url(),
            relaunch: relaunch_args(std::env::args_os().skip(1), &build.sha),
            updated_from: args.updated_from.clone(),
        },
        settings.clone(),
        Arc::new(AppWork {
            jobs: jobs.clone(),
            uploads: uploads.clone(),
        }),
    );
    updater.start();
    let state = AppState {
        store,
        jobs,
        info,
        uploads,
        updater,
        settings,
        shortcuts,
    };
    let web_dir = args
        .web_dir
        .or_else(|| media::exe_dir().map(|d| d.join("web")))
        .unwrap_or_else(|| PathBuf::from("web"));
    let mut origins = api::default_origins(args.port);
    origins.extend(args.allow_origin);
    let app = api::router(state, args.port, &origins, &web_dir);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let listener = match listener
            .set_nonblocking(true)
            .and_then(|()| tokio::net::TcpListener::from_std(listener))
        {
            Ok(l) => l,
            Err(e) => exit_with(&format!("VeoClone could not start: {e}")),
        };
        println!();
        println!(
            "  VeoClone {} · {}",
            env!("CARGO_PKG_VERSION"),
            build.describe()
        );
        if args.updated_from.is_some() {
            println!("  {}", update::UPDATED);
        }
        println!();
        println!("  Keep this window open while you use VeoClone.");
        println!("  If your browser did not open, go to {url}");
        println!("  Your matches are saved in {}", data.display());
        println!();
        if open_browser && open::that_detached(&url).is_err() {
            println!("  (Could not open the browser by itself.)");
        }
        if let Err(e) = axum::serve(listener, app).await {
            exit_with(&format!("VeoClone stopped: {e}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn onedrive_folders() {
        let roots = [OsString::from("/home/ross/OneDrive"), OsString::new()];
        assert!(inside_any(
            Path::new("/home/ross/OneDrive/Videos/VeoClone"),
            &roots
        ));
        assert!(inside_any(
            Path::new("/home/ross/onedrive/Videos/VeoClone"),
            &roots
        ));
        assert!(!inside_any(Path::new("/home/ross/Videos/VeoClone"), &roots));
        assert!(!inside_any(
            Path::new("/home/ross/OneDriveX/Videos"),
            &roots
        ));
        assert_eq!(data_dir(Some("/x".into())), PathBuf::from("/x"));
    }

    #[test]
    fn relaunched_with_the_same_options() {
        let args = [
            "--port",
            "47870",
            "--updated-from",
            "old",
            "--no-open",
            "--minimized",
            "--updated-from=x",
        ]
        .map(OsString::from);
        assert_eq!(
            relaunch_args(args.into_iter(), "abc"),
            ["--port", "47870", "--no-open", "--updated-from", "abc"].map(OsString::from)
        );
        // Both forms parse; hidden from --help.
        let a = Args::try_parse_from(["x", "--updated-from", "abc", "--minimized"]).unwrap();
        assert_eq!(a.updated_from.as_deref(), Some("abc"));
        assert!(a.minimized);
        assert!(
            !Args::command()
                .render_help()
                .to_string()
                .contains("updated-from")
        );
        assert!(version_text(&Build::dev()).ends_with("(development build)"));
        let b = Build::from_env(Some("abcdef0123"), Some("2026-10-25T09:30:00Z"));
        assert!(version_text(&b).ends_with("(build abcdef0, 25 Oct 2026)"));
    }

    #[test]
    fn retries_for_a_while() {
        let mut n = 0;
        let r: Result<(), ()> = retry(Some(Duration::from_secs(5)), || {
            n += 1;
            if n < 3 { Err(()) } else { Ok(()) }
        });
        assert!(r.is_ok());
        n = 0;
        assert!(
            retry(None, || -> Result<(), ()> {
                n += 1;
                Err(())
            })
            .is_err()
        );
        assert_eq!(n, 1);
    }

    #[test]
    fn folder_lock_is_exclusive() {
        let tmp = tempfile::tempdir().unwrap();
        let first = lock_folder(tmp.path()).unwrap();
        assert!(matches!(
            lock_folder(tmp.path()),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(first);
        assert!(lock_folder(tmp.path()).is_ok());
    }
}
