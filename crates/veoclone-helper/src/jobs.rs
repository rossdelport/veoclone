//! The job queue: exactly one heavy job (processing or export) runs at a
//! time, on its own thread, guarded by `catch_unwind`.

use std::collections::VecDeque;
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;

use crate::export::ExportRequest;
use crate::media::Tools;
use crate::store::{
    ErrorInfo, ExportStatus, JobInfo, JobKind, Status, Step, Store, end_unfinished_run, now_iso,
};

#[derive(Debug, Clone)]
pub enum Job {
    Process {
        project: String,
    },
    Export {
        project: String,
        export: String,
        request: Arc<ExportRequest>,
    },
}

impl Job {
    pub fn project(&self) -> &str {
        match self {
            Job::Process { project } | Job::Export { project, .. } => project,
        }
    }
}

/// Settings every job needs.
pub struct Context {
    pub store: Arc<Store>,
    pub tools: Tools,
    pub model: Option<PathBuf>,
}

/// How a job ended, when it did not succeed.
#[derive(Debug)]
pub enum JobError {
    Cancelled,
    Failed { message: String, detail: String },
}

impl JobError {
    pub fn failed(message: impl Into<String>, detail: impl std::fmt::Display) -> JobError {
        JobError::Failed {
            message: message.into(),
            detail: detail.to_string(),
        }
    }
}

struct Running {
    job: Job,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct State {
    queue: VecDeque<Job>,
    running: Option<Running>,
}

pub struct Jobs {
    state: Mutex<State>,
    wake: Condvar,
}

impl Jobs {
    /// Create the queue and start the worker thread.
    pub fn start(ctx: Context) -> Arc<Jobs> {
        let jobs = Arc::new(Jobs {
            state: Mutex::new(State::default()),
            wake: Condvar::new(),
        });
        let worker = jobs.clone();
        std::thread::Builder::new()
            .name("veoclone-jobs".into())
            .spawn(move || worker.run(ctx))
            .expect("spawn job worker");
        jobs
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn submit(&self, job: Job) {
        self.lock().queue.push_back(job);
        self.wake.notify_all();
    }

    /// Is a job for this project running or waiting?
    pub fn busy(&self, project: &str) -> bool {
        let s = self.lock();
        s.running
            .as_ref()
            .is_some_and(|r| r.job.project() == project)
            || s.queue.iter().any(|j| j.project() == project)
    }

    /// Is a job of this project running right now?
    pub fn running(&self, project: &str) -> bool {
        self.lock()
            .running
            .as_ref()
            .is_some_and(|r| r.job.project() == project)
    }

    /// Is processing (not an export) running or waiting for this project?
    pub fn processing(&self, project: &str) -> bool {
        let s = self.lock();
        let is_process = |j: &Job| matches!(j, Job::Process { project: p } if p == project);
        s.running.as_ref().is_some_and(|r| is_process(&r.job)) || s.queue.iter().any(is_process)
    }

    /// Is this exact export running right now?
    pub fn export_running(&self, project: &str, export: &str) -> bool {
        matches!(&self.lock().running, Some(Running { job: Job::Export { project: p, export: e, .. }, .. }) if p == project && e == export)
    }

    /// Remove one queued export (it has not started).
    pub fn remove_queued_export(&self, project: &str, export: &str) {
        self.lock().queue.retain(
            |j| !matches!(j, Job::Export { project: p, export: e, .. } if p == project && e == export),
        );
    }

    /// Stop the running job of a project and drop its queued ones. Returns
    /// the jobs that were removed from the queue (never started).
    pub fn cancel(&self, project: &str) -> Vec<Job> {
        let mut s = self.lock();
        if let Some(r) = &s.running
            && r.job.project() == project
        {
            r.cancel.store(true, Ordering::SeqCst);
        }
        let (removed, kept): (Vec<Job>, Vec<Job>) =
            s.queue.drain(..).partition(|j| j.project() == project);
        s.queue = kept.into();
        removed
    }

    fn next(&self) -> (Job, Arc<AtomicBool>) {
        let mut s = self.lock();
        loop {
            if let Some(job) = s.queue.pop_front() {
                let cancel = Arc::new(AtomicBool::new(false));
                s.running = Some(Running {
                    job: job.clone(),
                    cancel: cancel.clone(),
                });
                return (job, cancel);
            }
            s = self.wake.wait(s).unwrap_or_else(|e| e.into_inner());
        }
    }

    fn run(&self, ctx: Context) {
        loop {
            let (job, cancel) = self.next();
            keep_awake(true);
            let project = job.project().to_string();
            let dir = ctx.store.project_dir(&project);
            crate::logging::start_job_log(&dir.join("log.txt"));
            let started = Instant::now();
            tracing::info!("=== {} started ({}) ===", describe(&job), now_iso());

            let result = std::panic::catch_unwind(AssertUnwindSafe(|| match &job {
                Job::Process { project } => crate::process::run(&ctx, project, &cancel),
                Job::Export {
                    project,
                    export,
                    request,
                } => crate::export::run(&ctx, project, export, request, &cancel),
            }))
            .unwrap_or_else(|panic| {
                let detail = panic
                    .downcast_ref::<String>()
                    .cloned()
                    .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown panic".into());
                Err(JobError::failed(
                    "Something went wrong inside VeoClone. Press Try again.",
                    format!("panic: {detail}"),
                ))
            });
            // A cancel that arrived just as the job finished still counts.
            let result = match result {
                Ok(()) if cancel.load(Ordering::SeqCst) => Err(JobError::Cancelled),
                r => r,
            };
            let secs = started.elapsed().as_secs();
            match &result {
                Ok(()) => tracing::info!("=== Finished in {secs} s ==="),
                Err(JobError::Cancelled) => tracing::info!("=== Cancelled after {secs} s ==="),
                Err(JobError::Failed { message, detail }) => {
                    tracing::error!("=== Failed after {secs} s: {message} ({detail}) ===")
                }
            }
            finish(&ctx.store, &job, result);
            crate::logging::end_job_log();
            keep_awake(false);
            self.lock().running = None;
        }
    }
}

/// While a job runs, ask Windows not to go to sleep (the screen may still
/// turn off). The request belongs to the calling thread: the one thread
/// that runs every job.
fn keep_awake(on: bool) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Power::{
            ES_CONTINUOUS, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
        };
        let flags = if on {
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
        };
        // SAFETY: plain Win32 call with valid flags.
        unsafe { SetThreadExecutionState(flags) };
    }
    #[cfg(not(windows))]
    let _ = on;
}

/// Shown when a job failed and the disk is (nearly) full, which is the
/// likely reason.
const DISK_FULL: &str = "Your disk is full. Free up some space (for example by deleting old \
                             matches or videos) and press Try again.";

/// Below this much free space a failure is blamed on the full disk.
const NEARLY_FULL: u64 = 1 << 30;

/// Fail before a long job when the disk clearly cannot hold what it makes
/// (`need` bytes, a rough estimate).
pub fn check_free_space(dir: &std::path::Path, need: u64) -> Result<(), JobError> {
    match fs4::available_space(dir) {
        Ok(free) if free < need => Err(JobError::failed(
            format!(
                "There is not enough free disk space for this: about {} GB more is needed. \
                 Free up some space (for example by deleting old matches or videos) and \
                 press Try again.",
                (need - free).div_ceil(1 << 30)
            ),
            format!("{free} bytes free, about {need} needed"),
        )),
        _ => Ok(()),
    }
}

fn describe(job: &Job) -> String {
    match job {
        Job::Process { .. } => "Processing".into(),
        Job::Export { export, .. } => format!("Export {export}"),
    }
}

/// Record how a job ended in project.json.
fn finish(store: &Store, job: &Job, result: Result<(), JobError>) {
    let dir = store.project_dir(job.project());
    let result = match result {
        Err(JobError::Failed { message, detail })
            if fs4::available_space(&dir).is_ok_and(|free| free < NEARLY_FULL) =>
        {
            Err(JobError::failed(DISK_FULL, format!("{message} ({detail})")))
        }
        r => r,
    };
    store.update(job.project(), |m| {
        m.job = None;
        match job {
            Job::Process { .. } => match result {
                Ok(()) => {
                    m.status = Status::Ready;
                    m.error = None;
                    m.interrupted_runs = 0;
                }
                Err(JobError::Cancelled) => end_unfinished_run(m, &dir, None),
                Err(JobError::Failed { message, detail }) => {
                    let error = ErrorInfo {
                        message,
                        detail: Some(detail),
                    };
                    end_unfinished_run(m, &dir, Some(error));
                }
            },
            Job::Export { export, .. } => {
                if let Some(ex) = m.exports.iter_mut().find(|e| &e.id == export) {
                    match result {
                        Ok(()) => {
                            ex.status = ExportStatus::Done;
                            ex.progress = 1.0;
                        }
                        Err(JobError::Cancelled) => ex.status = ExportStatus::Cancelled,
                        Err(JobError::Failed { message, detail }) => {
                            ex.status = ExportStatus::Failed;
                            // First line in plain words, then the
                            // technical detail.
                            ex.error = Some(format!("{message}\n{detail}"));
                        }
                    }
                }
            }
        }
    });
}

/// Reports progress of the running job into `ProjectMeta.job`.
pub struct Progress<'a> {
    store: &'a Store,
    project: String,
    export: Option<String>,
    step_started: Instant,
    started_at: String,
    kind: JobKind,
    step_count: u32,
}

impl<'a> Progress<'a> {
    pub fn new(store: &'a Store, project: &str, export: Option<&str>, step_count: u32) -> Self {
        Progress {
            store,
            project: project.to_string(),
            export: export.map(str::to_string),
            step_started: Instant::now(),
            started_at: now_iso(),
            kind: if export.is_some() {
                JobKind::Export
            } else {
                JobKind::Process
            },
            step_count,
        }
    }

    /// Start a new step (saved to disk right away).
    pub fn step(&mut self, step: Step, index: u32, message: &str) {
        self.step_started = Instant::now();
        tracing::info!("Step {}/{}: {message}", index + 1, self.step_count);
        let info = JobInfo {
            kind: self.kind,
            export_id: self.export.clone(),
            step,
            step_index: index,
            step_count: self.step_count,
            progress: 0.0,
            frames_done: None,
            frames_total: None,
            eta_seconds: None,
            message: message.to_string(),
            started_at: self.started_at.clone(),
        };
        self.store.update(&self.project, |m| m.job = Some(info));
    }

    /// Progress within the current step, as a fraction.
    pub fn fraction(&self, progress: f64, message: Option<&str>) {
        let progress = progress.clamp(0.0, 1.0);
        self.store.update_progress(&self.project, |m| {
            if let Some(job) = m.job.as_mut() {
                job.progress = progress;
                if let Some(msg) = message {
                    job.message = msg.to_string();
                }
            }
        });
    }

    /// Progress within the current step, in frames (adds a time estimate).
    pub fn frames(&self, done: u64, total: u64) {
        let progress = if total > 0 {
            (done as f64 / total as f64).clamp(0.0, 1.0)
        } else {
            0.0
        };
        let elapsed = self.step_started.elapsed().as_secs_f64();
        let eta = (done > 0 && elapsed > 2.0)
            .then(|| elapsed / done as f64 * total.saturating_sub(done) as f64);
        let export = self.export.clone();
        self.store.update_progress(&self.project, |m| {
            if let Some(job) = m.job.as_mut() {
                job.progress = progress;
                job.frames_done = Some(done);
                job.frames_total = Some(total);
                job.eta_seconds = eta.map(|e| e.round());
            }
            if let Some(id) = export
                && let Some(ex) = m.exports.iter_mut().find(|e| e.id == id)
            {
                ex.progress = progress;
            }
        });
    }
}
