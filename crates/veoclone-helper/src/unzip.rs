//! A small reader for the update zip (DESIGN.md 4.11): the stored and
//! deflated files of an ordinary zip file, each checked against its CRC-32
//! and size, written below one folder. Zip64, encryption and other
//! compression methods are refused (the release zip, made by Info-ZIP
//! `zip -9`, uses none of them). The zip's SHA-256 is checked before it gets
//! here; the names are still checked so nothing lands outside the folder.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const EOCD: u32 = 0x0605_4b50;
const CENTRAL: u32 = 0x0201_4b50;
const LOCAL: u32 = 0x0403_4b50;
const STORED: u16 = 0;
const DEFLATED: u16 = 8;

/// One file or folder in the zip, from the central directory.
#[derive(Debug, Clone)]
pub struct Entry {
    pub name: String,
    method: u16,
    flags: u16,
    crc: u32,
    compressed: u64,
    pub size: u64,
    local_offset: u64,
    /// Unix permission bits, when the zip was made on Unix.
    unix_mode: Option<u32>,
}

impl Entry {
    pub fn is_dir(&self) -> bool {
        self.name.ends_with('/')
    }
}

fn u16_at(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}

/// The central directory of the zip file.
pub fn entries(file: &mut File) -> Result<Vec<Entry>, String> {
    let len = file.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
    // End of central directory: 22 bytes plus a comment of up to 64 KiB.
    let tail_len = len.min(22 + 0xFFFF);
    let mut tail = vec![0u8; tail_len as usize];
    file.seek(SeekFrom::Start(len - tail_len))
        .and_then(|_| file.read_exact(&mut tail))
        .map_err(|e| e.to_string())?;
    let eocd = (0..tail.len().saturating_sub(21))
        .rev()
        .find(|&i| {
            u32_at(&tail, i) == EOCD && i + 22 + u16_at(&tail, i + 20) as usize == tail.len()
        })
        .ok_or("not a zip file (no end of central directory)")?;
    let e = &tail[eocd..];
    let count = u16_at(e, 10);
    let cd_size = u32_at(e, 12);
    let cd_offset = u32_at(e, 16);
    if u16_at(e, 4) != 0 || u16_at(e, 6) != 0 || u16_at(e, 8) != count {
        return Err("zip files in several parts are not supported".into());
    }
    if count == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        return Err("zip64 files are not supported".into());
    }
    let (cd_offset, cd_size) = (cd_offset as u64, cd_size as u64);
    if cd_offset + cd_size > len - tail_len + eocd as u64 {
        return Err("the central directory is outside the file".into());
    }
    let mut cd = vec![0u8; cd_size as usize];
    file.seek(SeekFrom::Start(cd_offset))
        .and_then(|_| file.read_exact(&mut cd))
        .map_err(|e| e.to_string())?;

    let mut out = Vec::with_capacity(count as usize);
    let mut at = 0usize;
    for _ in 0..count {
        if at + 46 > cd.len() || u32_at(&cd, at) != CENTRAL {
            return Err("damaged central directory".into());
        }
        let h = &cd[at..];
        let made_on = h[5];
        let (name_len, extra_len, comment_len) = (
            u16_at(h, 28) as usize,
            u16_at(h, 30) as usize,
            u16_at(h, 32) as usize,
        );
        if at + 46 + name_len + extra_len + comment_len > cd.len() {
            return Err("damaged central directory".into());
        }
        let name = String::from_utf8(h[46..46 + name_len].to_vec())
            .map_err(|_| "a file name in the zip is not UTF-8".to_string())?;
        let compressed = u32_at(h, 20);
        let size = u32_at(h, 24);
        let local = u32_at(h, 42);
        if compressed == 0xFFFF_FFFF || size == 0xFFFF_FFFF || local == 0xFFFF_FFFF {
            return Err("zip64 files are not supported".into());
        }
        let external = u32_at(h, 38);
        out.push(Entry {
            name,
            method: u16_at(h, 10),
            flags: u16_at(h, 8),
            crc: u32_at(h, 16),
            compressed: compressed as u64,
            size: size as u64,
            local_offset: local as u64,
            unix_mode: (made_on == 3).then_some(external >> 16),
        });
        at += 46 + name_len + extra_len + comment_len;
    }
    Ok(out)
}

/// `name` below `prefix` as a safe relative path ("web/assets/x.js"), or an
/// error. Only plain names: no `..`, no drive letters or `:` (Windows
/// alternate data streams), no backslashes, no names Windows would change.
pub fn relative_name<'a>(name: &'a str, prefix: &str) -> Result<&'a str, String> {
    let rel = name
        .strip_prefix(prefix)
        .ok_or_else(|| format!("{name} is not inside {prefix}"))?;
    let rel = rel.strip_suffix('/').unwrap_or(rel);
    let bad = |part: &str| {
        part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with('.')
            || part.ends_with(' ')
            || part.chars().any(|c| {
                c.is_control() || matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            })
    };
    if rel.is_empty() || rel.split('/').any(bad) {
        return Err(format!("unsafe file name in the zip: {name:?}"));
    }
    Ok(rel)
}

/// Total size of the files below `prefix` once unpacked.
pub fn unpacked_size(entries: &[Entry]) -> u64 {
    entries.iter().map(|e| e.size).sum()
}

/// Unpack every entry below `prefix` (e.g. `"VeoClone/"`) into `dest`,
/// which must be empty or missing. Every entry must be below `prefix`.
/// Returns the relative paths of the files, sorted.
pub fn extract(zip: &Path, prefix: &str, dest: &Path) -> Result<Vec<String>, String> {
    let mut file = File::open(zip).map_err(|e| format!("open {}: {e}", zip.display()))?;
    let list = entries(&mut file)?;
    std::fs::create_dir_all(dest).map_err(|e| format!("create {}: {e}", dest.display()))?;
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for entry in &list {
        if entry.name == prefix {
            continue;
        }
        let rel = relative_name(&entry.name, prefix)?;
        if !seen.insert(rel.to_ascii_lowercase()) {
            return Err(format!("{rel} is in the zip twice"));
        }
        let target: PathBuf = rel.split('/').fold(dest.to_path_buf(), |p, c| p.join(c));
        if entry.is_dir() {
            std::fs::create_dir_all(&target).map_err(|e| format!("create {rel}: {e}"))?;
            continue;
        }
        unpack(&mut file, entry, &target).map_err(|e| format!("{rel}: {e}"))?;
        files.push(rel.to_string());
    }
    files.sort();
    Ok(files)
}

fn unpack(file: &mut File, entry: &Entry, target: &Path) -> Result<(), String> {
    if entry.flags & 1 != 0 {
        return Err("encrypted".into());
    }
    let mut header = [0u8; 30];
    file.seek(SeekFrom::Start(entry.local_offset))
        .and_then(|_| file.read_exact(&mut header))
        .map_err(|e| e.to_string())?;
    if u32_at(&header, 0) != LOCAL {
        return Err("damaged local header".into());
    }
    let data = entry.local_offset + 30 + u16_at(&header, 26) as u64 + u16_at(&header, 28) as u64;
    file.seek(SeekFrom::Start(data))
        .map_err(|e| e.to_string())?;
    let raw = BufReader::with_capacity(1 << 16, Read::by_ref(file)).take(entry.compressed);
    let mut reader: Box<dyn Read> = match entry.method {
        STORED => Box::new(raw),
        DEFLATED => Box::new(flate2::read::DeflateDecoder::new(raw)),
        m => return Err(format!("compression method {m} is not supported")),
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut out = File::create(target).map_err(|e| e.to_string())?;
    let mut crc = flate2::Crc::new();
    let mut written = 0u64;
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        written += n as u64;
        if written > entry.size {
            return Err("bigger than the zip says".into());
        }
        crc.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    if written != entry.size || crc.sum() != entry.crc {
        return Err("damaged (wrong size or checksum)".into());
    }
    out.sync_all().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    if let Some(mode) = entry.unix_mode
        && mode & 0o111 != 0
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(target, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = entry.unix_mode;
    Ok(())
}

/// Writes simple zip files for tests (stored or deflated, Unix modes).
#[cfg(test)]
pub mod testzip {
    use std::io::Write;

    /// `(name, contents, executable)`; names ending in `/` are folders.
    pub fn make(files: &[(&str, &[u8], bool)], deflate: bool) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, data, exec) in files {
            let mut crc = flate2::Crc::new();
            crc.update(data);
            let (method, body): (u16, Vec<u8>) = if deflate && !name.ends_with('/') {
                let mut enc =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::best());
                enc.write_all(data).unwrap();
                (8, enc.finish().unwrap())
            } else {
                (0, data.to_vec())
            };
            let offset = out.len() as u32;
            let common = |v: &mut Vec<u8>| {
                v.extend_from_slice(&20u16.to_le_bytes()); // version needed
                v.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 names
                v.extend_from_slice(&method.to_le_bytes());
                v.extend_from_slice(&[0, 0, 0x21, 0]); // time, date
                v.extend_from_slice(&crc.sum().to_le_bytes());
                v.extend_from_slice(&(body.len() as u32).to_le_bytes());
                v.extend_from_slice(&(data.len() as u32).to_le_bytes());
                v.extend_from_slice(&(name.len() as u16).to_le_bytes());
                v.extend_from_slice(&0u16.to_le_bytes()); // extra
            };
            out.extend_from_slice(&super::LOCAL.to_le_bytes());
            common(&mut out);
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(&body);

            central.extend_from_slice(&super::CENTRAL.to_le_bytes());
            central.extend_from_slice(&0x031Eu16.to_le_bytes()); // made on Unix
            common(&mut central);
            central.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // comment, disk, internal
            let mode: u32 = if name.ends_with('/') {
                0o040755
            } else if *exec {
                0o100755
            } else {
                0o100644
            };
            central.extend_from_slice(&(mode << 16).to_le_bytes());
            central.extend_from_slice(&offset.to_le_bytes());
            central.extend_from_slice(name.as_bytes());
        }
        let cd_offset = out.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&super::EOCD.to_le_bytes());
        out.extend_from_slice(&[0, 0, 0, 0]);
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&cd_offset.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<(&'static str, &'static [u8], bool)> {
        vec![
            ("VeoClone/", b"", false),
            ("VeoClone/VeoClone.exe", b"new program", true),
            ("VeoClone/web/", b"", false),
            ("VeoClone/web/index.html", b"<html>hello</html>", false),
            ("VeoClone/models/yolo.onnx", &[7u8; 100_000], false),
        ]
    }

    #[test]
    fn unpacks_stored_and_deflated_files() {
        for deflate in [false, true] {
            let tmp = tempfile::tempdir().unwrap();
            let zip = tmp.path().join("a.zip");
            std::fs::write(&zip, testzip::make(&sample(), deflate)).unwrap();
            let dest = tmp.path().join("out");
            let files = extract(&zip, "VeoClone/", &dest).unwrap();
            assert_eq!(
                files,
                ["VeoClone.exe", "models/yolo.onnx", "web/index.html"]
            );
            assert_eq!(
                std::fs::read(dest.join("web/index.html")).unwrap(),
                b"<html>hello</html>"
            );
            assert_eq!(
                std::fs::read(dest.join("models/yolo.onnx")).unwrap(),
                vec![7u8; 100_000]
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = |p: &str| {
                    std::fs::metadata(dest.join(p))
                        .unwrap()
                        .permissions()
                        .mode()
                };
                assert_eq!(mode("VeoClone.exe") & 0o111, 0o111);
                assert_eq!(mode("web/index.html") & 0o111, 0);
            }
            let mut f = File::open(&zip).unwrap();
            assert_eq!(unpacked_size(&entries(&mut f).unwrap()), 100_000 + 11 + 18);
        }
    }

    /// A zip made by Python's zipfile (what the e2e test uses), if Python is here.
    #[test]
    fn unpacks_a_zip_from_python() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("py.zip");
        let script = "import sys, zipfile\n\
                      with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:\n\
                      \x20   z.writestr('VeoClone/a.txt', 'A' * 5000)\n\
                      \x20   z.writestr('VeoClone/sub/b.txt', b'')\n";
        let Ok(status) = std::process::Command::new("python3")
            .args(["-I", "-c", script])
            .arg(&zip)
            .status()
        else {
            eprintln!("python3 not found; skipped");
            return;
        };
        assert!(status.success());
        let dest = tmp.path().join("out");
        assert_eq!(
            extract(&zip, "VeoClone/", &dest).unwrap(),
            ["a.txt", "sub/b.txt"]
        );
        assert_eq!(std::fs::read(dest.join("a.txt")).unwrap(), vec![b'A'; 5000]);
        assert!(dest.join("sub/b.txt").is_file());
    }

    /// The release zip is made with Info-ZIP `zip -q -r -9` (the publish job
    /// of veoclone-windows.yml), if it is here.
    #[test]
    fn unpacks_a_zip_from_info_zip() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        std::fs::create_dir_all(src.join("VeoClone/web/assets")).unwrap();
        std::fs::create_dir_all(src.join("VeoClone/licenses/ONNX Runtime")).unwrap();
        std::fs::write(src.join("VeoClone/VeoClone.exe"), vec![0x4d; 300_000]).unwrap();
        std::fs::write(src.join("VeoClone/web/assets/index-1.js"), "x".repeat(9000)).unwrap();
        std::fs::write(src.join("VeoClone/licenses/ONNX Runtime/LICENSE"), "MIT").unwrap();
        std::fs::write(src.join("VeoClone/empty.txt"), "").unwrap();
        let zip = tmp.path().join("VeoClone-windows.zip");
        let Ok(status) = std::process::Command::new("zip")
            .args(["-q", "-r", "-9"])
            .arg(&zip)
            .arg("VeoClone")
            .current_dir(&src)
            .status()
        else {
            eprintln!("zip not found; skipped");
            return;
        };
        assert!(status.success());
        let dest = tmp.path().join("out");
        assert_eq!(
            extract(&zip, "VeoClone/", &dest).unwrap(),
            [
                "VeoClone.exe",
                "empty.txt",
                "licenses/ONNX Runtime/LICENSE",
                "web/assets/index-1.js"
            ]
        );
        assert_eq!(
            std::fs::read(dest.join("VeoClone.exe")).unwrap(),
            vec![0x4d; 300_000]
        );
        assert_eq!(
            std::fs::read_to_string(dest.join("licenses/ONNX Runtime/LICENSE")).unwrap(),
            "MIT"
        );
    }

    #[test]
    fn refuses_damaged_or_unsafe_zips() {
        let tmp = tempfile::tempdir().unwrap();
        let zip = tmp.path().join("a.zip");
        let check = |bytes: Vec<u8>, needle: &str| {
            std::fs::write(&zip, bytes).unwrap();
            let dest = tmp.path().join(format!("out-{}", uuid::Uuid::new_v4()));
            let err = extract(&zip, "VeoClone/", &dest).unwrap_err();
            assert!(err.contains(needle), "{err:?} should mention {needle:?}");
        };
        // A flipped byte in a stored file: the CRC catches it.
        let mut bytes = testzip::make(&sample(), false);
        let at = bytes.windows(11).position(|w| w == b"new program").unwrap();
        bytes[at] ^= 1;
        check(bytes, "checksum");
        // Cut short.
        let bytes = testzip::make(&sample(), true);
        check(bytes[..bytes.len() / 2].to_vec(), "not a zip");
        check(b"hello".to_vec(), "not a zip");
        // Names that would land outside the folder, or outside VeoClone/.
        for name in [
            "VeoClone/../evil.dll",
            "VeoClone/a/../../evil.dll",
            "VeoClone//evil.dll",
            "VeoClone/C:evil.dll",
            "VeoClone/a\\..\\evil.dll",
            "VeoClone/evil.dll ",
            "VeoClone/evil.dll:stream",
        ] {
            check(testzip::make(&[(name, b"x", false)], false), "unsafe");
        }
        check(
            testzip::make(&[("Other/evil.dll", b"x", false)], false),
            "not inside",
        );
        check(
            testzip::make(
                &[
                    ("VeoClone/a.dll", b"x", false),
                    ("VeoClone/A.dll", b"y", false),
                ],
                false,
            ),
            "twice",
        );
    }

    #[test]
    fn relative_names() {
        assert_eq!(relative_name("VeoClone/a/b.js", "VeoClone/"), Ok("a/b.js"));
        assert_eq!(relative_name("VeoClone/web/", "VeoClone/"), Ok("web"));
        assert!(relative_name("VeoClone/", "VeoClone/").is_err());
        assert!(relative_name("/etc/passwd", "VeoClone/").is_err());
    }
}
