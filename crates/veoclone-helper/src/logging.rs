//! Logging: a calm console for the user, every library message of the
//! running job in that project's `log.txt`, and a tap that notices when the
//! ONNX runtime really registered DirectML.

use std::fs::File;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::Ordering;

use tracing::field::{Field, Visit};
use tracing_subscriber::Layer;
use tracing_subscriber::filter::{EnvFilter, Targets};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// The log file of the job that is running now (one job at a time).
static JOB_LOG: Mutex<Option<File>> = Mutex::new(None);

/// Send log output to `path` (appending) until [`end_job_log`].
pub fn start_job_log(path: &Path) {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path);
    *JOB_LOG.lock().unwrap_or_else(|e| e.into_inner()) = file.ok();
}

pub fn end_job_log() {
    *JOB_LOG.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

struct JobLogWriter;

impl Write for JobLogWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if let Some(f) = JOB_LOG.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
            let _ = f.write_all(buf);
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

struct JobLog;

impl<'a> MakeWriter<'a> for JobLog {
    type Writer = JobLogWriter;
    fn make_writer(&'a self) -> JobLogWriter {
        JobLogWriter
    }
}

/// Watches ort's own messages: `Successfully registered
/// \`DmlExecutionProvider\`` is the only reliable sign DirectML is in use
/// (Reco logs "DirectML enabled" even when registration failed).
struct DirectMlTap;

struct MessageVisitor(String);

impl Visit for MessageVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0 = format!("{value:?}");
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.0 = value.to_string();
        }
    }
}

pub fn is_directml_success(message: &str) -> bool {
    message.contains("Successfully registered") && message.contains("DmlExecutionProvider")
}

impl<S: tracing::Subscriber> Layer<S> for DirectMlTap {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        let mut v = MessageVisitor(String::new());
        event.record(&mut v);
        if is_directml_success(&v.0) {
            crate::ai::DIRECTML_REGISTERED.store(true, Ordering::SeqCst);
        }
    }
}

/// Install the global logger. `RUST_LOG` overrides the console filter.
pub fn init() {
    let console_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("error,veoclone_helper=info"));
    let console = tracing_subscriber::fmt::layer()
        .with_target(false)
        .without_time()
        // Older Windows consoles print colour codes as garbage.
        .with_ansi(cfg!(not(windows)))
        .with_writer(std::io::stderr)
        .with_filter(console_filter);
    let job_filter: Targets = "info,ort=warn,wgpu_core=warn,wgpu_hal=warn,naga=warn"
        .parse()
        .expect("valid filter");
    let job = tracing_subscriber::fmt::layer()
        .with_ansi(false)
        .with_writer(JobLog)
        .with_filter(job_filter);
    let tap = DirectMlTap.with_filter(Targets::new().with_target("ort", tracing::Level::INFO));
    let _ = tracing_subscriber::registry()
        .with(console)
        .with(job)
        .with(tap)
        .try_init();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_directml_message() {
        assert!(is_directml_success(
            "Successfully registered `DmlExecutionProvider`"
        ));
        assert!(!is_directml_success(
            "Couldn't register `DmlExecutionProvider`: missing feature"
        ));
        assert!(!is_directml_success(
            "Successfully registered `CPUExecutionProvider`"
        ));
    }

    #[test]
    fn tap_sees_ort_events() {
        let subscriber = tracing_subscriber::registry()
            .with(DirectMlTap.with_filter(Targets::new().with_target("ort", tracing::Level::INFO)));
        crate::ai::DIRECTML_REGISTERED.store(false, Ordering::SeqCst);
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(target: "other", "Successfully registered `DmlExecutionProvider`");
            assert!(!crate::ai::DIRECTML_REGISTERED.load(Ordering::SeqCst));
            // The exact form ort uses (src/ep/mod.rs).
            let source = "SessionBuilder::with_execution_providers";
            tracing::info!(target: "ort::ep", %source, "Successfully registered `{}`", "DmlExecutionProvider");
        });
        assert!(crate::ai::DIRECTML_REGISTERED.load(Ordering::SeqCst));
    }
}
