//! Windows shortcuts (DESIGN.md 4.11).
//!
//! - "Start VeoClone when Windows starts": a shortcut `VeoClone.lnk` in the
//!   user's Startup folder (`%APPDATA%\Microsoft\Windows\Start
//!   Menu\Programs\Startup`) that runs `VeoClone.exe --no-open --minimized`
//!   in a minimised window. The shortcut is the setting: the toggle shows
//!   whether it is there.
//! - A Start menu shortcut "VeoClone", made once on the first run of a
//!   release build.
//!
//! Both are real `.lnk` files written with the shell's `IShellLinkW` COM
//! object, which needs no extra program. On every start the shortcuts that
//! exist are written again, so they follow the VeoClone folder when the user
//! moves it. Elsewhere than Windows there are no shortcuts.

use std::path::{Path, PathBuf};

/// The shortcuts' file name (both folders).
const LINK: &str = "VeoClone.lnk";
/// What the Startup shortcut passes: no browser tab, window minimised.
pub const STARTUP_ARGS: &str = "--no-open --minimized";

pub struct Shortcuts {
    exe: PathBuf,
    /// The Startup folder, when this system has one.
    startup: Option<PathBuf>,
    /// The Start menu's Programs folder, when this system has one.
    programs: Option<PathBuf>,
}

impl Shortcuts {
    /// Shortcuts that start `exe`.
    pub fn new(exe: PathBuf) -> Shortcuts {
        #[cfg(windows)]
        let (startup, programs) = (
            win::known_folder(&windows::Win32::UI::Shell::FOLDERID_Startup),
            win::known_folder(&windows::Win32::UI::Shell::FOLDERID_Programs),
        );
        #[cfg(not(windows))]
        let (startup, programs) = (None, None);
        Shortcuts {
            exe,
            startup,
            programs,
        }
    }

    fn startup_link(&self) -> Option<PathBuf> {
        self.startup.as_ref().map(|d| d.join(LINK))
    }

    fn start_menu_link(&self) -> Option<PathBuf> {
        self.programs.as_ref().map(|d| d.join(LINK))
    }

    /// Does VeoClone start with Windows? `None` where that is not possible.
    pub fn start_with_windows(&self) -> Option<bool> {
        self.startup_link().map(|l| l.is_file())
    }

    /// Add or remove the Startup shortcut.
    pub fn set_start_with_windows(&self, on: bool) -> Result<(), String> {
        let link = self
            .startup_link()
            .ok_or("Starting with Windows only works on Windows.")?;
        if on {
            write_link(&link, &self.exe, STARTUP_ARGS, true)
        } else {
            match std::fs::remove_file(&link) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
                _ => Ok(()),
            }
        }
    }

    /// At start: point the shortcuts that exist at this program (the folder
    /// may have been moved), and make the Start menu shortcut the first time
    /// (`first_time`). Returns whether the Start menu shortcut was made.
    pub fn refresh(&self, first_time: bool) -> bool {
        if let Some(link) = self.startup_link().filter(|l| l.is_file())
            && let Err(e) = write_link(&link, &self.exe, STARTUP_ARGS, true)
        {
            log::warn!("Could not update {}: {e}", link.display());
        }
        let Some(link) = self.start_menu_link() else {
            return false;
        };
        if !first_time && !link.is_file() {
            return false; // deleted by the user: leave it
        }
        match write_link(&link, &self.exe, "", false) {
            Ok(()) => {
                if first_time {
                    log::info!("Added VeoClone to the Start menu");
                }
                true
            }
            Err(e) => {
                log::warn!("Could not write {}: {e}", link.display());
                false
            }
        }
    }
}

#[cfg(windows)]
fn write_link(link: &Path, exe: &Path, args: &str, minimized: bool) -> Result<(), String> {
    win::write_link(link, exe, args, minimized).map_err(|e| e.message().to_string())
}

#[cfg(not(windows))]
fn write_link(_link: &Path, _exe: &Path, _args: &str, _minimized: bool) -> Result<(), String> {
    Err("Shortcuts only work on Windows.".into())
}

/// `--minimized`: minimise the console window (the shortcut asks for a
/// minimised window too; this also covers terminals that ignore it).
pub fn minimize_console() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Console::GetConsoleWindow;
        use windows_sys::Win32::UI::WindowsAndMessaging::{SW_SHOWMINNOACTIVE, ShowWindow};
        // SAFETY: plain Win32 calls; a null window is checked.
        unsafe {
            let window = GetConsoleWindow();
            if !window.is_null() {
                ShowWindow(window, SW_SHOWMINNOACTIVE);
            }
        }
    }
}

#[cfg(windows)]
mod win {
    use std::os::windows::ffi::OsStringExt;
    use std::path::{Path, PathBuf};

    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoTaskMemFree, CoUninitialize, IPersistFile,
    };
    use windows::Win32::UI::Shell::{
        IShellLinkW, KF_FLAG_DEFAULT, SHGetKnownFolderPath, ShellLink,
    };
    use windows::Win32::UI::WindowsAndMessaging::{SW_SHOWMINNOACTIVE, SW_SHOWNORMAL};
    use windows::core::{GUID, HSTRING, Interface};

    /// A folder such as the Startup folder (follows folder redirection).
    pub fn known_folder(id: &GUID) -> Option<PathBuf> {
        // SAFETY: the returned string is read, then freed as documented.
        unsafe {
            let p = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, None).ok()?;
            let path = PathBuf::from(std::ffi::OsString::from_wide(p.as_wide()));
            CoTaskMemFree(Some(p.0 as *const _));
            Some(path)
        }
    }

    /// Write a `.lnk` file that starts `exe args` in its own folder.
    pub fn write_link(
        link: &Path,
        exe: &Path,
        args: &str,
        minimized: bool,
    ) -> windows::core::Result<()> {
        // SAFETY: COM calls on interfaces created here; COM is set up for
        // this thread first and released after (when this call set it up).
        unsafe {
            let init = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let result = (|| {
                let shell: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                shell.SetPath(&HSTRING::from(exe))?;
                shell.SetArguments(&HSTRING::from(args))?;
                if let Some(dir) = exe.parent() {
                    shell.SetWorkingDirectory(&HSTRING::from(dir))?;
                }
                shell.SetDescription(&HSTRING::from(
                    "VeoClone: turns two phone videos of a match into one",
                ))?;
                shell.SetIconLocation(&HSTRING::from(exe), 0)?;
                // "Run: Minimised" in the shortcut's properties.
                shell.SetShowCmd(if minimized {
                    SW_SHOWMINNOACTIVE
                } else {
                    SW_SHOWNORMAL
                })?;
                let file: IPersistFile = shell.cast()?;
                file.Save(&HSTRING::from(link), true)
            })();
            if init.is_ok() {
                CoUninitialize();
            }
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_shortcuts_off_windows() {
        let s = Shortcuts::new(PathBuf::from("/opt/VeoClone/VeoClone"));
        if cfg!(windows) {
            return;
        }
        assert_eq!(s.start_with_windows(), None);
        assert!(s.set_start_with_windows(true).is_err());
        assert!(!s.refresh(true));
        minimize_console(); // does nothing
    }
}
