//! VeoClone helper: a small local web server that keeps the user's matches
//! on disk and runs the heavy work (calibration, AI tracking, export) with
//! the Reco libraries. The editor (web/) talks to it over HTTP.

mod ai;
mod api;
mod calib;
mod export;
mod jobs;
mod logging;
mod media;
mod process;
mod store;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use clap::Parser;

use crate::api::{AppState, GpuInfo, HelperInfo};
use crate::jobs::{Context, Jobs};
use crate::store::Store;

#[derive(Parser, Debug)]
#[command(
    name = "veoclone-helper",
    version,
    about = "VeoClone helper (local server)"
)]
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
    let args = Args::parse();
    put_exe_dir_on_path();
    logging::init();
    let url = format!("http://127.0.0.1:{}/", args.port);

    // One VeoClone at a time. The port is taken before anything else: a
    // second copy must not tidy up the folder the first one is working in.
    let listener = match std::net::TcpListener::bind(("127.0.0.1", args.port)) {
        Ok(l) => l,
        Err(e) => {
            if !args.no_open {
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
    let _lock = match lock_folder(&data) {
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
    let state = AppState {
        store,
        jobs,
        info,
        uploads: Default::default(),
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
        println!("  VeoClone {}", env!("CARGO_PKG_VERSION"));
        println!();
        println!("  Keep this window open while you use VeoClone.");
        println!("  If your browser did not open, go to {url}");
        println!("  Your matches are saved in {}", data.display());
        println!();
        if !args.no_open && open::that_detached(&url).is_err() {
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
