//! Putting a new version of VeoClone in place of the running one
//! (DESIGN.md 4.11).
//!
//! Windows lets a running program and the DLLs it has loaded be renamed,
//! but not overwritten or deleted. So every file that is replaced is first
//! renamed to a backup (`<name>.old`), then the new file is moved in from
//! the staging folder. The steps are written down first (`swap.json`), so a
//! swap that was cut short (say by a power cut) is undone on the next start,
//! a failed swap is undone at once, and the backups are deleted once the new
//! version runs. Only files of the two versions are touched: the new
//! version's files and the old version's (from its `version.json`), never
//! anything else in the folder, and never the matches (they are in the data
//! folder, elsewhere).
//!
//! Everything here works on any platform, so it is tested on Linux.

use std::collections::{BTreeSet, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// Folder inside the install folder for the update's own files.
pub const WORK_DIR: &str = ".veoclone-update";
/// The new version, unpacked (inside [`WORK_DIR`]).
pub const STAGING: &str = "new";
/// The plan of a swap in progress (inside [`WORK_DIR`]).
pub const JOURNAL: &str = "swap.json";

pub fn work_dir(install: &Path) -> PathBuf {
    install.join(WORK_DIR)
}

pub fn staging_dir(install: &Path) -> PathBuf {
    work_dir(install).join(STAGING)
}

fn journal_path(install: &Path) -> PathBuf {
    work_dir(install).join(JOURNAL)
}

/// `a/b/c` → `<root>/a/b/c`.
fn under(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, c| p.join(c))
}

/// One file of a swap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Move {
    /// Relative path in the install folder, `/`-separated.
    pub path: String,
    /// Where the old file goes first (relative), when there is one.
    pub backup: Option<String>,
    /// A new file comes in from the staging folder (else the old file is
    /// only removed: the new version no longer has it).
    pub replace: bool,
}

/// What a swap does, in order. Saved as `swap.json` before it starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Plan {
    /// Build (commit) of the version that is being replaced.
    pub from: String,
    /// Build of the new version.
    pub to: String,
    pub moves: Vec<Move>,
    /// Folders the new version needs that are not there yet, parents first.
    pub new_dirs: Vec<String>,
}

/// Plan replacing the files in `install` with the files of the staging
/// folder (`new_files`, relative, `/`-separated). `old_files`: the files of
/// the running version (its `version.json`); those the new version no
/// longer has are removed (backed up like the others). `exe`: the program's
/// file name; it is swapped last, so a swap that stops half-way always
/// leaves the old program in place and the next start undoes it.
pub fn plan(
    install: &Path,
    new_files: &[String],
    old_files: &[String],
    exe: &str,
    from: &str,
    to: &str,
) -> Plan {
    let mut taken: HashSet<String> = HashSet::new();
    let mut backup_for = |rel: &str| -> Option<String> {
        if !under(install, rel).is_file() {
            return None;
        }
        let mut n = 0;
        loop {
            let name = if n == 0 {
                format!("{rel}.old")
            } else {
                format!("{rel}.{n}.old")
            };
            let path = under(install, &name);
            // A backup left over from an earlier update that could not be
            // deleted then (the old program was still closing).
            if path.exists() {
                let _ = std::fs::remove_file(&path);
            }
            if !path.exists() && taken.insert(name.to_ascii_lowercase()) {
                return Some(name);
            }
            n += 1;
        }
    };

    let (mut programs, mut others): (Vec<&String>, Vec<&String>) =
        new_files.iter().partition(|f| f.eq_ignore_ascii_case(exe));
    others.sort();
    let mut moves: Vec<Move> = others
        .into_iter()
        .map(|f| Move {
            path: f.clone(),
            backup: backup_for(f),
            replace: true,
        })
        .collect();
    // Windows does not tell "A.dll" from "a.dll": compare without case.
    let new_lower: HashSet<String> = new_files.iter().map(|f| f.to_ascii_lowercase()).collect();
    let mut gone: Vec<&String> = old_files
        .iter()
        .filter(|f| !new_lower.contains(&f.to_ascii_lowercase()))
        .filter(|f| !f.starts_with(WORK_DIR) && under(install, f).is_file())
        .collect();
    gone.sort();
    gone.dedup();
    moves.extend(gone.into_iter().map(|f| Move {
        path: f.clone(),
        backup: backup_for(f),
        replace: false,
    }));
    programs.truncate(1);
    moves.extend(programs.into_iter().map(|f| Move {
        path: f.clone(),
        backup: backup_for(f),
        replace: true,
    }));

    let mut dirs = BTreeSet::new();
    for f in new_files {
        let mut parent = Path::new(f.as_str()).parent();
        while let Some(p) = parent.filter(|p| !p.as_os_str().is_empty()) {
            let rel = p.to_string_lossy().replace('\\', "/");
            if !under(install, &rel).is_dir() {
                dirs.insert(rel);
            }
            parent = p.parent();
        }
    }
    // Parents before children ("web" < "web/assets").
    let mut new_dirs: Vec<String> = dirs.into_iter().collect();
    new_dirs.sort_by_key(|d| d.matches('/').count());
    Plan {
        from: from.to_string(),
        to: to.to_string(),
        moves,
        new_dirs,
    }
}

/// Rename, retrying for a moment: on Windows a virus scanner or the search
/// indexer can hold a new file open briefly.
pub fn rename_retrying(from: &Path, to: &Path) -> io::Result<()> {
    let mut tries = 0;
    loop {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if tries < 8 && from.exists() => {
                tries += 1;
                log::debug!("Rename {} failed ({e}), trying again", from.display());
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(e) => return Err(e),
        }
    }
}

/// Carry out `plan`, saving it first. On any problem everything done so far
/// is undone and the error is returned. `rename` is [`rename_retrying`]
/// (tests make it fail on purpose).
pub fn apply(
    install: &Path,
    plan: &Plan,
    rename: &mut dyn FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<(), String> {
    let staging = staging_dir(install);
    let json = serde_json::to_vec_pretty(plan).map_err(|e| e.to_string())?;
    crate::store::write_atomic(&journal_path(install), &json)
        .map_err(|e| format!("could not save the update plan: {e}"))?;
    let mut run = || -> Result<(), String> {
        for dir in &plan.new_dirs {
            std::fs::create_dir_all(under(install, dir))
                .map_err(|e| format!("could not create {dir}: {e}"))?;
        }
        for m in &plan.moves {
            let path = under(install, &m.path);
            if let Some(backup) = &m.backup
                && path.exists()
            {
                rename(&path, &under(install, backup))
                    .map_err(|e| format!("could not move {} out of the way: {e}", m.path))?;
            }
            if m.replace {
                rename(&under(&staging, &m.path), &path)
                    .map_err(|e| format!("could not put the new {} in place: {e}", m.path))?;
            }
        }
        Ok(())
    };
    match run() {
        Ok(()) => Ok(()),
        Err(e) => {
            log::warn!("Update: {e}; putting the old files back");
            match rollback(install, plan) {
                Ok(()) => Err(e),
                Err(r) => Err(format!("{e}; and putting the old files back failed: {r}")),
            }
        }
    }
}

/// Undo `plan` as far as it got (works from what is on disk, so it also
/// finishes an earlier undo): new files go back to the staging folder and
/// the backups back to their names. Then the plan is deleted.
pub fn rollback(install: &Path, plan: &Plan) -> Result<(), String> {
    let staging = staging_dir(install);
    let mut problems = Vec::new();
    for m in plan.moves.iter().rev() {
        let path = under(install, &m.path);
        let new = under(&staging, &m.path);
        if m.replace && !new.exists() && path.exists() {
            if let Some(parent) = new.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = rename_retrying(&path, &new) {
                problems.push(format!("{}: {e}", m.path));
                continue;
            }
        }
        if let Some(backup) = &m.backup {
            let backup = under(install, backup);
            if backup.exists()
                && !path.exists()
                && let Err(e) = rename_retrying(&backup, &path)
            {
                problems.push(format!("{}: {e}", m.path));
            }
        }
    }
    for dir in plan.new_dirs.iter().rev() {
        // Only when empty: anything else in it is not ours.
        let _ = std::fs::remove_dir(under(install, dir));
    }
    if problems.is_empty() {
        let _ = std::fs::remove_file(journal_path(install));
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

/// The swap worked: delete the backups, the staging folder and the plan.
/// Returns the backups that could not be deleted yet (the old program may
/// still be closing); the plan is kept until they are gone.
pub fn commit(install: &Path, plan: &Plan) -> Vec<String> {
    let left: Vec<String> = plan
        .moves
        .iter()
        .filter_map(|m| m.backup.as_ref())
        .filter(|b| {
            let p = under(install, b);
            p.exists() && std::fs::remove_file(&p).is_err()
        })
        .cloned()
        .collect();
    if left.is_empty() {
        // Only the update's own files are in there.
        let _ = std::fs::remove_dir_all(work_dir(install));
    } else {
        let _ = std::fs::remove_dir_all(staging_dir(install));
    }
    left
}

/// What [`recover`] found.
#[derive(Debug, PartialEq, Eq)]
pub enum Recovery {
    /// No swap was in progress.
    Nothing,
    /// This is the version a swap put in place: its backups can go
    /// (call [`commit`] with the plan).
    Finish(Plan),
    /// A swap to a new version was cut short and has been undone.
    RolledBack,
    /// Undoing a cut-short swap failed (details); the plan is kept.
    RollbackFailed(String),
}

/// Look for a swap that was in progress when VeoClone last stopped. `me`:
/// this program's build. Called at start, before anything else uses the
/// install folder.
pub fn recover(install: &Path, me: &str) -> Recovery {
    let path = journal_path(install);
    let Ok(bytes) = std::fs::read(&path) else {
        // An unpacked update that was never put in place: unpacked again
        // when needed.
        let _ = std::fs::remove_dir_all(work_dir(install));
        return Recovery::Nothing;
    };
    let plan: Plan = match serde_json::from_slice(&bytes) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("Update: unreadable {}: {e}", path.display());
            let _ = std::fs::remove_file(&path);
            return Recovery::Nothing;
        }
    };
    if plan.to == me {
        Recovery::Finish(plan)
    } else if plan.from == me {
        match rollback(install, &plan) {
            Ok(()) => {
                let _ = std::fs::remove_dir_all(staging_dir(install));
                Recovery::RolledBack
            }
            Err(e) => Recovery::RollbackFailed(e),
        }
    } else {
        // Neither version (the folder was replaced by hand): the backups
        // are of an older version; tidy up.
        Recovery::Finish(plan)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pretend install folder (old version) and staging folder (new).
    struct Fake {
        _tmp: tempfile::TempDir,
        install: PathBuf,
    }

    const OLD: &[(&str, &str)] = &[
        ("VeoClone.exe", "old exe"),
        ("avcodec-61.dll", "old codec"),
        ("onnxruntime.dll", "old ort"),
        ("version.json", "old version"),
        ("web/index.html", "old index"),
        ("web/assets/index-old.js", "old js"),
        ("models/yolo26n.onnx", "model"),
    ];
    const NEW: &[(&str, &str)] = &[
        ("VeoClone.exe", "new exe"),
        ("avcodec-62.dll", "new codec"),
        ("onnxruntime.dll", "new ort"),
        ("version.json", "new version"),
        ("web/index.html", "new index"),
        ("web/assets/index-new.js", "new js"),
        ("models/yolo26n.onnx", "model"),
        ("licenses/New/LICENSE.txt", "new licence"),
    ];

    fn fake() -> Fake {
        let tmp = tempfile::tempdir().unwrap();
        let install = tmp.path().join("VeoClone");
        for (rel, text) in OLD {
            let p = under(&install, rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        // The user's own file in the folder: never touched.
        std::fs::write(install.join("my notes.txt"), "mine").unwrap();
        let staging = staging_dir(&install);
        for (rel, text) in NEW {
            let p = under(&staging, rel);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        Fake { _tmp: tmp, install }
    }

    fn names(list: &[(&str, &str)]) -> Vec<String> {
        list.iter().map(|(n, _)| n.to_string()).collect()
    }

    /// Every file below `dir` with its text, except the update's own folder.
    fn tree(dir: &Path) -> Vec<(String, String)> {
        let mut out = Vec::new();
        fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
            for e in std::fs::read_dir(dir).unwrap().flatten() {
                let p = e.path();
                let rel = p
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .replace('\\', "/");
                if rel.starts_with(WORK_DIR) {
                    continue;
                }
                if p.is_dir() {
                    walk(root, &p, out);
                } else {
                    out.push((rel, std::fs::read_to_string(&p).unwrap()));
                }
            }
        }
        walk(dir, dir, &mut out);
        out.sort();
        out
    }

    fn expect(list: &[(&str, &str)]) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = list
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .chain([("my notes.txt".to_string(), "mine".to_string())])
            .collect();
        v.sort();
        v
    }

    fn plan_for(f: &Fake) -> Plan {
        plan(
            &f.install,
            &names(NEW),
            &names(OLD),
            "VeoClone.exe",
            "aaa",
            "bbb",
        )
    }

    #[test]
    fn plans_replacements_removals_and_the_program_last() {
        let f = fake();
        let p = plan_for(&f);
        let paths: Vec<&str> = p.moves.iter().map(|m| m.path.as_str()).collect();
        assert_eq!(paths.last(), Some(&"VeoClone.exe"));
        let gone: Vec<&str> = p
            .moves
            .iter()
            .filter(|m| !m.replace)
            .map(|m| m.path.as_str())
            .collect();
        assert_eq!(gone, ["avcodec-61.dll", "web/assets/index-old.js"]);
        let m = |path: &str| p.moves.iter().find(|m| m.path == path).unwrap().clone();
        assert_eq!(
            m("onnxruntime.dll").backup.as_deref(),
            Some("onnxruntime.dll.old")
        );
        assert_eq!(m("avcodec-62.dll").backup, None);
        assert_eq!(p.new_dirs, ["licenses", "licenses/New"]);
        assert!(!paths.contains(&"my notes.txt"));

        // A backup that is still there from before gets another name if it
        // cannot be deleted (here: it is a folder).
        std::fs::create_dir(f.install.join("onnxruntime.dll.old")).unwrap();
        let p = plan_for(&f);
        let m = p
            .moves
            .iter()
            .find(|m| m.path == "onnxruntime.dll")
            .unwrap();
        assert_eq!(m.backup.as_deref(), Some("onnxruntime.dll.1.old"));
    }

    #[test]
    fn swap_then_commit() {
        let f = fake();
        let p = plan_for(&f);
        apply(&f.install, &p, &mut |a, b| std::fs::rename(a, b)).unwrap();
        // The new files, the backups, and the user's file.
        let mut want = expect(NEW);
        want.extend(
            [
                ("VeoClone.exe.old", "old exe"),
                ("avcodec-61.dll.old", "old codec"),
                ("onnxruntime.dll.old", "old ort"),
                ("version.json.old", "old version"),
                ("web/index.html.old", "old index"),
                ("web/assets/index-old.js.old", "old js"),
                ("models/yolo26n.onnx.old", "model"),
            ]
            .map(|(a, b)| (a.to_string(), b.to_string())),
        );
        want.sort();
        assert_eq!(tree(&f.install), want);
        assert!(journal_path(&f.install).is_file());

        // The new version starts and finds the plan.
        let Recovery::Finish(found) = recover(&f.install, "bbb") else {
            panic!("expected Finish");
        };
        assert_eq!(found, p);
        // The updater's own note of what it unpacked goes too.
        std::fs::write(work_dir(&f.install).join("staged.json"), "{}").unwrap();
        assert!(commit(&f.install, &found).is_empty());
        assert_eq!(tree(&f.install), expect(NEW));
        assert!(!work_dir(&f.install).exists());
        assert_eq!(recover(&f.install, "bbb"), Recovery::Nothing);
    }

    /// Any file that cannot be moved (in use by another program) puts every
    /// old file back, wherever it happens.
    #[test]
    fn a_failed_swap_puts_everything_back() {
        let mut tried = 0;
        for fail_at in 0.. {
            let f = fake();
            let before = tree(&f.install);
            let staged = tree(&staging_dir(&f.install));
            let p = plan_for(&f);
            let mut n = 0;
            let result = apply(&f.install, &p, &mut |a, b| {
                n += 1;
                if n > fail_at {
                    Err(io::Error::other("in use"))
                } else {
                    std::fs::rename(a, b)
                }
            });
            let Err(err) = result else {
                break; // every rename happened before `fail_at`
            };
            tried += 1;
            assert!(err.contains("in use"), "{err}");
            assert_eq!(tree(&f.install), before, "failing at rename {fail_at}");
            assert_eq!(tree(&staging_dir(&f.install)), staged);
            assert!(!journal_path(&f.install).exists());
            assert!(!f.install.join("licenses").exists());
        }
        // 5 replaced files (two renames each), 3 new and 2 removed (one each).
        assert_eq!(tried, 5 * 2 + 3 + 2);
    }

    /// A swap cut short (power cut): the old program starts again and
    /// undoes it.
    #[test]
    fn an_interrupted_swap_is_undone_on_the_next_start() {
        let f = fake();
        let before = tree(&f.install);
        let p = plan_for(&f);
        // Do half of it by hand, as if the PC went off then.
        crate::store::write_atomic(&journal_path(&f.install), &serde_json::to_vec(&p).unwrap())
            .unwrap();
        for dir in &p.new_dirs {
            std::fs::create_dir_all(under(&f.install, dir)).unwrap();
        }
        let staging = staging_dir(&f.install);
        for m in p.moves.iter().take(3) {
            if let Some(b) = &m.backup {
                std::fs::rename(under(&f.install, &m.path), under(&f.install, b)).unwrap();
            }
            std::fs::rename(under(&staging, &m.path), under(&f.install, &m.path)).unwrap();
        }
        // Backed up, but the new file not moved in yet.
        let m = &p.moves[3];
        std::fs::rename(
            under(&f.install, &m.path),
            under(&f.install, m.backup.as_ref().unwrap()),
        )
        .unwrap();
        assert_ne!(tree(&f.install), before);
        assert_eq!(recover(&f.install, "aaa"), Recovery::RolledBack);
        assert_eq!(tree(&f.install), before);
        assert!(!work_dir(&f.install).join(STAGING).exists());
        assert!(!journal_path(&f.install).exists());
    }

    #[test]
    fn leftovers_and_unknown_plans() {
        let f = fake();
        // An unpacked update that was never used is removed at start.
        assert_eq!(recover(&f.install, "aaa"), Recovery::Nothing);
        assert!(!staging_dir(&f.install).exists());
        // A plan between two other versions (the folder was replaced by
        // hand): tidy up its backups.
        std::fs::write(f.install.join("VeoClone.exe.old"), "older").unwrap();
        let p = Plan {
            from: "x".into(),
            to: "y".into(),
            moves: vec![Move {
                path: "VeoClone.exe".into(),
                backup: Some("VeoClone.exe.old".into()),
                replace: true,
            }],
            new_dirs: vec![],
        };
        std::fs::create_dir_all(work_dir(&f.install)).unwrap();
        std::fs::write(journal_path(&f.install), serde_json::to_vec(&p).unwrap()).unwrap();
        let Recovery::Finish(found) = recover(&f.install, "zzz") else {
            panic!()
        };
        assert!(commit(&f.install, &found).is_empty());
        assert!(!f.install.join("VeoClone.exe.old").exists());
        assert_eq!(
            std::fs::read(f.install.join("VeoClone.exe")).unwrap(),
            b"old exe"
        );
        // A damaged plan is ignored.
        std::fs::create_dir_all(work_dir(&f.install)).unwrap();
        std::fs::write(journal_path(&f.install), b"{").unwrap();
        assert_eq!(recover(&f.install, "aaa"), Recovery::Nothing);
    }

    #[test]
    fn same_name_in_another_case_is_not_removed() {
        let f = fake();
        let mut new = names(NEW);
        new.retain(|n| n != "onnxruntime.dll");
        new.push("OnnxRuntime.dll".into());
        let p = plan(&f.install, &new, &names(OLD), "VeoClone.exe", "a", "b");
        assert!(
            !p.moves
                .iter()
                .any(|m| !m.replace && m.path == "onnxruntime.dll")
        );
    }
}
