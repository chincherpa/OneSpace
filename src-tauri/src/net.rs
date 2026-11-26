//! Network-aware path handling: UNC shares and mapped drives, plus
//! file-system probing that can never hang the app on an unreachable server.

use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::sync::{mpsc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

/// How long a share may take to answer before it counts as offline.
const SHARE_TIMEOUT: Duration = Duration::from_secs(2);
/// Upper bound for a whole probe call; unanswered paths are reported offline.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(6);
/// Share reachability and drive mappings are cached this long.
const CACHE_TTL: Duration = Duration::from_secs(30);

/// Removes verbatim prefixes (`\\?\`, `\\?\UNC\`) and unifies separators.
pub fn normalize(p: &str) -> String {
    let p = p.replace('/', "\\");
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = p.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        p
    }
}

/// The network share a path lives on.
pub struct NetRoot {
    /// Share as UNC, e.g. `\\server\projekte`.
    pub unc: String,
    /// How the share appears at the start of the path: the UNC itself or a drive like `Z:`.
    pub prefix: String,
}

impl NetRoot {
    /// `server\projekte` for display.
    pub fn display(&self) -> &str {
        self.unc.trim_start_matches('\\')
    }
}

pub fn net_root(path: &str) -> Option<NetRoot> {
    let p = normalize(path);
    if let Some(rest) = p.strip_prefix(r"\\") {
        let mut parts = rest.splitn(3, '\\');
        let server = parts.next().filter(|s| !s.is_empty())?;
        let share = parts.next().filter(|s| !s.is_empty())?;
        let unc = format!(r"\\{server}\{share}");
        return Some(NetRoot { prefix: unc.clone(), unc });
    }
    let b = p.as_bytes();
    if b.len() >= 2 && b[1] == b':' && b[0].is_ascii_alphabetic() {
        let drive = p[..2].to_uppercase();
        return mapped_drive(&drive).map(|unc| NetRoot { unc, prefix: drive });
    }
    None
}

/// Comparison key: mapped drives are resolved to their UNC share and case is ignored,
/// so `Z:\a.pdf` and `\\server\share\a.pdf` count as the same file.
pub fn path_key(path: &str) -> String {
    let p = to_unc(path);
    let p = p.trim_end_matches('\\');
    if cfg!(windows) {
        p.to_lowercase()
    } else {
        p.to_string()
    }
}

/// `Z:\a.pdf` -> `\\server\share\a.pdf` for mapped drives; other paths only normalized.
pub fn to_unc(path: &str) -> String {
    let p = normalize(path);
    match net_root(&p) {
        Some(r) => format!("{}{}", r.unc, &p[r.prefix.len()..]),
        None => p,
    }
}

// ---------- mapped drives ----------

/// Makes sure the mapped drive `path` is on is actually connected. Windows restores
/// remembered drives lazily (Explorer shows them with a red X) and connects them only
/// when Explorer touches them; until then every other program gets "path not found".
/// Returns false for paths not on a mapped drive and when reconnecting failed
/// (e.g. because credentials are needed).
pub fn reconnect_drive(path: &str) -> bool {
    let Some(r) = net_root(path) else { return false };
    if r.prefix == r.unc {
        return false; // plain UNC path, nothing to connect
    }
    if fs::metadata(format!("{}\\", r.prefix)).is_ok() {
        return true;
    }
    connect_drive(&r.prefix, &r.unc) && fs::metadata(format!("{}\\", r.prefix)).is_ok()
}

#[cfg(windows)]
fn connect_drive(drive: &str, unc: &str) -> bool {
    use windows_sys::Win32::NetworkManagement::WNet::{WNetAddConnection2W, NETRESOURCEW, RESOURCETYPE_DISK};

    let mut local: Vec<u16> = drive.encode_utf16().chain(Some(0)).collect();
    let mut remote: Vec<u16> = unc.encode_utf16().chain(Some(0)).collect();
    let res = NETRESOURCEW {
        dwType: RESOURCETYPE_DISK,
        lpLocalName: local.as_mut_ptr(),
        lpRemoteName: remote.as_mut_ptr(),
        ..Default::default()
    };
    // SAFETY: both strings are NUL-terminated and outlive the call; null password and
    // user mean "current user / stored credentials". Flags 0: the remembered mapping stays as is.
    let rc = unsafe { WNetAddConnection2W(&res, std::ptr::null(), std::ptr::null(), 0) };
    rc == 0
}

#[cfg(not(windows))]
fn connect_drive(_: &str, _: &str) -> bool {
    false
}

type DriveCache = Mutex<HashMap<String, (Instant, Option<String>)>>;

fn mapped_drive(drive: &str) -> Option<String> {
    static CACHE: OnceLock<DriveCache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some((t, v)) = cache.lock().ok()?.get(drive) {
        if t.elapsed() < CACHE_TTL {
            return v.clone();
        }
    }
    let v = query_mapped_drive(drive);
    if let Ok(mut c) = cache.lock() {
        c.insert(drive.to_string(), (Instant::now(), v.clone()));
    }
    v
}

/// Looks up the UNC target of a mapped drive, including remembered but disconnected ones.
#[cfg(windows)]
fn query_mapped_drive(drive: &str) -> Option<String> {
    use windows_sys::Win32::Foundation::{ERROR_CONNECTION_UNAVAIL, NO_ERROR};
    use windows_sys::Win32::NetworkManagement::WNet::WNetGetConnectionW;

    let local: Vec<u16> = drive.encode_utf16().chain(Some(0)).collect();
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    // SAFETY: `local` is NUL-terminated, `buf` holds `len` u16s.
    let rc = unsafe { WNetGetConnectionW(local.as_ptr(), buf.as_mut_ptr(), &mut len) };
    if rc != NO_ERROR && rc != ERROR_CONNECTION_UNAVAIL {
        return None; // local drive (ERROR_NOT_CONNECTED) or error
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let s = String::from_utf16_lossy(&buf[..end]);
    let s = s.trim_end_matches('\\');
    (!s.is_empty()).then(|| s.to_string())
}

#[cfg(not(windows))]
fn query_mapped_drive(_: &str) -> Option<String> {
    None
}

// ---------- probing ----------

#[derive(Debug, Serialize, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Ok,
    Missing,
    /// The network share did not answer; the file may well still exist.
    Offline,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub path: String,
    pub status: Status,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified: Option<u64>,
}

impl Probe {
    fn without_stat(path: &str, status: Status) -> Self {
        Self { path: path.to_string(), status, is_dir: false, size: None, modified: None }
    }
}

fn stat(path: &str) -> Probe {
    match fs::metadata(path) {
        Ok(m) => Probe {
            path: path.to_string(),
            status: Status::Ok,
            is_dir: m.is_dir(),
            size: m.is_file().then(|| m.len()),
            modified: m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64),
        },
        Err(_) => Probe::without_stat(path, Status::Missing),
    }
}

type ShareCache = Mutex<HashMap<String, (Instant, bool)>>;

fn share_cache() -> &'static ShareCache {
    static CACHE: OnceLock<ShareCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn remember_share(unc: &str, online: bool) {
    if let Ok(mut c) = share_cache().lock() {
        c.insert(unc.to_lowercase(), (Instant::now(), online));
    }
}

/// Whether a share answers within `SHARE_TIMEOUT`. The check runs on a helper
/// thread, so a hanging SMB connection only ever costs that thread.
fn share_online(unc: &str) -> bool {
    let key = unc.to_lowercase();
    if let Ok(c) = share_cache().lock() {
        if let Some((t, ok)) = c.get(&key) {
            if t.elapsed() < CACHE_TTL {
                return *ok;
            }
        }
    }
    let (tx, rx) = mpsc::channel();
    let root = format!("{unc}\\");
    thread::spawn(move || {
        let _ = tx.send(fs::metadata(&root).is_ok());
    });
    let online = rx.recv_timeout(SHARE_TIMEOUT).unwrap_or(false);
    remember_share(unc, online);
    online
}

/// Drops the cached reachability of the share `path` lives on, so the next probe asks again.
pub fn forget_share(path: &str) {
    if let Some(r) = net_root(path) {
        if let Ok(mut c) = share_cache().lock() {
            c.remove(&r.unc.to_lowercase());
        }
    }
}

/// The deepest existing folder above `path`. If none answers (e.g. a disconnected
/// mapped drive), the path's own parent folder is returned so the file manager can
/// reconnect it. Bounded by `SHARE_TIMEOUT`.
pub fn nearest_folder(path: &str) -> String {
    let p = normalize(path);
    let parent = std::path::Path::new(&p)
        .parent()
        .map(|d| d.display().to_string())
        .filter(|d| !d.is_empty())
        .unwrap_or_else(|| p.clone());
    let (tx, rx) = mpsc::channel();
    let start = parent.clone();
    thread::spawn(move || {
        let found = std::path::Path::new(&start)
            .ancestors()
            .find(|d| fs::metadata(d).map(|m| m.is_dir()).unwrap_or(false))
            .map(|d| d.display().to_string());
        let _ = tx.send(found);
    });
    rx.recv_timeout(SHARE_TIMEOUT).ok().flatten().unwrap_or(parent)
}

/// Stats all paths, grouped by share and in parallel. Paths on unreachable
/// shares are reported `Offline` instead of blocking. Never takes much longer
/// than `TOTAL_TIMEOUT`.
pub fn probe_all(paths: &[String]) -> Vec<Probe> {
    // share (lowercase) -> (UNC, paths); local paths use the key "".
    let mut groups: HashMap<String, (Option<String>, Vec<String>)> = HashMap::new();
    for p in paths {
        let root = net_root(p).map(|r| r.unc);
        let key = root.as_deref().unwrap_or("").to_lowercase();
        groups.entry(key).or_insert_with(|| (root, vec![])).1.push(p.clone());
    }

    let (tx, rx) = mpsc::channel::<Vec<Probe>>();
    let count = groups.len();
    for (_, (root, items)) in groups {
        let tx = tx.clone();
        thread::spawn(move || {
            let online = root.as_deref().map_or(true, share_online);
            if online && root.is_some() {
                // The share answers, so a disconnected mapped drive on it only needs reconnecting.
                let mut drives = std::collections::HashSet::new();
                for p in &items {
                    if let Some(r) = net_root(p).filter(|r| r.prefix != r.unc) {
                        if drives.insert(r.prefix) {
                            reconnect_drive(p);
                        }
                    }
                }
            }
            let res = items
                .iter()
                .map(|p| if online { stat(p) } else { Probe::without_stat(p, Status::Offline) })
                .collect();
            let _ = tx.send(res);
        });
    }
    drop(tx);

    let deadline = Instant::now() + TOTAL_TIMEOUT;
    let mut done: HashMap<String, Probe> = HashMap::new();
    for _ in 0..count {
        match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
            Ok(v) => done.extend(v.into_iter().map(|p| (p.path.clone(), p))),
            Err(_) => break,
        }
    }

    paths
        .iter()
        .map(|p| {
            done.get(p).cloned().unwrap_or_else(|| {
                // The share went away mid-probe: remember it as offline.
                if let Some(r) = net_root(p) {
                    remember_share(&r.unc, false);
                }
                Probe::without_stat(p, Status::Offline)
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unc_root_and_normalize() {
        let r = net_root(r"\\?\UNC\nas\projekte\A\b.pdf").unwrap();
        assert_eq!(r.unc, r"\\nas\projekte");
        assert_eq!(r.display(), r"nas\projekte");
        assert!(net_root(r"\\nas").is_none());
        assert_eq!(normalize(r"\\?\C:\x"), r"C:\x");
    }

    #[test]
    #[cfg(windows)] // case-insensitive only on Windows
    fn keys_ignore_case_and_trailing_slash() {
        assert_eq!(path_key(r"\\NAS\Projekte\a.pdf\"), path_key(r"\\nas\projekte\A.PDF"));
    }

    #[test]
    fn nearest_folder_walks_up_to_existing_dir() {
        let dir = std::env::temp_dir();
        let deep = dir.join("onespace-nope-1").join("nope-2").join("file.pdf");
        let found = nearest_folder(&deep.display().to_string());
        assert_eq!(path_key(&found), path_key(&dir.display().to_string()));
    }

    #[test]
    fn probe_local_and_unreachable_share() {
        let dir = std::env::temp_dir();
        let missing = dir.join("onespace-does-not-exist-42").display().to_string();
        let paths = vec![dir.display().to_string(), missing];
        let res = probe_all(&paths);
        assert_eq!(res[0].status, Status::Ok);
        assert!(res[0].is_dir);
        assert_eq!(res[1].status, Status::Missing);
    }
}

