//! VeoClone's own settings, kept in `<data>/settings.json` (DESIGN.md 4.11):
//! whether it updates itself, and whether it already offered the Start menu
//! shortcut. "Start with Windows" is not stored here: the shortcut in the
//! Startup folder is the setting (see `shortcuts.rs`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::store::write_atomic;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Check for, download and install new versions by itself.
    pub auto_update: bool,
    /// The Start menu shortcut was made once (not again if the user
    /// deletes it).
    pub start_menu_done: bool,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            auto_update: true,
            start_menu_done: false,
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// Read `<data>/settings.json`; missing or damaged: the defaults.
    pub fn open(data_dir: &Path) -> SettingsStore {
        let path = data_dir.join("settings.json");
        let current = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                log::warn!("Damaged {}, using the defaults: {e}", path.display());
                Settings::default()
            }),
            Err(_) => Settings::default(),
        };
        SettingsStore {
            path,
            current: Mutex::new(current),
        }
    }

    pub fn get(&self) -> Settings {
        self.current
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Change the settings and save them. Kept in memory even when saving
    /// fails (the error is returned).
    pub fn update(&self, f: impl FnOnce(&mut Settings)) -> std::io::Result<Settings> {
        let mut s = self.current.lock().unwrap_or_else(|e| e.into_inner());
        f(&mut s);
        let json = serde_json::to_vec_pretty(&*s).map_err(std::io::Error::other)?;
        write_atomic(&self.path, &json)?;
        Ok(s.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_and_read_back() {
        let tmp = tempfile::tempdir().unwrap();
        let s = SettingsStore::open(tmp.path());
        assert_eq!(s.get(), Settings::default());
        assert!(s.get().auto_update);
        s.update(|s| s.auto_update = false).unwrap();
        assert!(!SettingsStore::open(tmp.path()).get().auto_update);
        // Unknown and missing fields are fine; a damaged file gives defaults.
        std::fs::write(
            tmp.path().join("settings.json"),
            r#"{"startMenuDone":true,"x":1}"#,
        )
        .unwrap();
        let s = SettingsStore::open(tmp.path()).get();
        assert!(s.auto_update && s.start_menu_done);
        std::fs::write(tmp.path().join("settings.json"), "{").unwrap();
        assert_eq!(SettingsStore::open(tmp.path()).get(), Settings::default());
    }
}
