mod clipboard;
mod net;
mod store;

use net::{Probe, Status};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use store::{normalize_tags, now_ms, read_data, write_data, Error, Item, Kind, Result, Settings, Space, Store};
use tauri::{AppHandle, Manager, State};

type AppStore = Mutex<Store>;

const DATA_FILE: &str = "spaces.json";

/// Where settings live, the default data file, and a problem found at startup (if any).
struct Config {
    settings_file: PathBuf,
    default_data_file: PathBuf,
    startup_warning: Mutex<Option<String>>,
}

const PALETTE: &[&str] = &[
    "#4f7cff", "#16a37f", "#e2683c", "#a35bd6", "#d4a017", "#d6457a", "#2e9bc4", "#6b7a8f",
];

// ---------- view models ----------
// Views are built from the stored map only. Anything that touches the file system
// (existence, size, date) goes through `probe`, which runs off the main thread and
// cannot hang on unreachable network shares.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpaceSummary {
    id: String,
    name: String,
    color: String,
    created_at: u64,
    item_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ItemView {
    id: String,
    path: String,
    kind: Kind,
    name: String,
    label: Option<String>,
    note: String,
    tags: Vec<String>,
    added_at: u64,
    extension: String,
    /// Human readable origin, e.g. "Dokumente", "OneDrive", "Netzwerk · nas\projekte".
    location: String,
    network: bool,
    parent: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpaceView {
    id: String,
    name: String,
    description: String,
    color: String,
    created_at: u64,
    items: Vec<ItemView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AddResult {
    added: usize,
    duplicates: usize,
    missing: Vec<String>,
    offline: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchHit {
    space_id: String,
    space_name: String,
    space_color: String,
    item: ItemView,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TagCount {
    name: String,
    count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpaceHealth {
    space_id: String,
    missing: usize,
    offline: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyResult {
    copied: usize,
    missing: usize,
    offline: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageInfo {
    path: String,
    default_path: String,
    is_default: bool,
    /// Set when the configured file could not be used at startup and the default was loaded instead.
    warning: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocationCheck {
    path: String,
    exists: bool,
    /// Number of spaces in an existing, readable file.
    spaces: Option<usize>,
    /// Why an existing file cannot be read.
    error: Option<String>,
}

fn known_locations() -> &'static [(String, String)] {
    static KNOWN: OnceLock<Vec<(String, String)>> = OnceLock::new();
    KNOWN.get_or_init(|| {
        let mut v: Vec<(String, PathBuf)> = Vec::new();
        for var in ["OneDriveCommercial", "OneDriveConsumer", "OneDrive"] {
            if let Ok(p) = std::env::var(var) {
                v.push(("OneDrive".into(), PathBuf::from(p)));
            }
        }
        let dirs = [
            ("Dokumente", dirs::document_dir()),
            ("Downloads", dirs::download_dir()),
            ("Desktop", dirs::desktop_dir()),
            ("Bilder", dirs::picture_dir()),
            ("Musik", dirs::audio_dir()),
            ("Videos", dirs::video_dir()),
            ("Benutzerordner", dirs::home_dir()),
        ];
        v.extend(dirs.into_iter().filter_map(|(n, d)| d.map(|d| (n.to_string(), d))));
        // Compare on canonical keys; most specific (longest) match wins.
        let mut keyed: Vec<(String, String)> = v
            .into_iter()
            .map(|(n, d)| (n, net::path_key(&d.to_string_lossy())))
            .collect();
        keyed.sort_by_key(|(_, k)| std::cmp::Reverse(k.len()));
        keyed
    })
}

/// Returns (label, is_network).
fn location_of(path: &str) -> (String, bool) {
    let key = net::path_key(path);
    let root = net::net_root(path);
    for (name, dir) in known_locations() {
        // Known folders such as Documents may be redirected to a share; the folder name wins.
        if key.len() > dir.len() && key.starts_with(dir.as_str()) && key.as_bytes()[dir.len()] == b'\\' {
            return (name.clone(), root.is_some());
        }
    }
    if let Some(r) = root {
        return (format!("Netzwerk · {}", r.display()), true);
    }
    let p = net::normalize(path);
    match p.as_bytes() {
        [d, b':', ..] if d.is_ascii_alphabetic() => (format!("Laufwerk {}:", (*d as char).to_ascii_uppercase()), false),
        _ => (p.split('\\').find(|s| !s.is_empty()).unwrap_or_default().to_string(), false),
    }
}

fn view_item(item: &Item) -> ItemView {
    let p = Path::new(&item.path);
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| item.path.clone());
    let (location, network) = location_of(&item.path);
    ItemView {
        id: item.id.clone(),
        path: item.path.clone(),
        kind: item.kind,
        name,
        label: item.label.clone(),
        note: item.note.clone(),
        tags: item.tags.clone(),
        added_at: item.added_at,
        extension: p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default(),
        location,
        network,
        parent: p.parent().map(|x| x.display().to_string()).unwrap_or_default(),
    }
}

fn summary(s: &Space) -> SpaceSummary {
    SpaceSummary {
        id: s.id.clone(),
        name: s.name.clone(),
        color: s.color.clone(),
        created_at: s.created_at,
        item_count: s.items.len(),
    }
}

fn lock<'a>(st: &'a State<AppStore>) -> Result<std::sync::MutexGuard<'a, Store>> {
    st.lock().map_err(|_| Error::Other("store lock poisoned".into()))
}

/// Runs blocking work (file system, shell) on a worker thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| Error::Other(e.to_string()))
}

// ---------- commands: map ----------

#[tauri::command]
fn list_spaces(st: State<AppStore>) -> Result<Vec<SpaceSummary>> {
    Ok(lock(&st)?.data.spaces.iter().map(summary).collect())
}

#[tauri::command]
fn get_space(st: State<AppStore>, id: String) -> Result<SpaceView> {
    let store = lock(&st)?;
    let s = store.space(&id)?;
    Ok(SpaceView {
        id: s.id.clone(),
        name: s.name.clone(),
        description: s.description.clone(),
        color: s.color.clone(),
        created_at: s.created_at,
        items: s.items.iter().map(view_item).collect(),
    })
}

#[tauri::command]
fn create_space(st: State<AppStore>, name: String) -> Result<SpaceSummary> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(Error::EmptyName);
    }
    let mut store = lock(&st)?;
    let color = PALETTE[store.data.spaces.len() % PALETTE.len()].to_string();
    let space = Space {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        description: String::new(),
        color,
        created_at: now_ms(),
        items: vec![],
    };
    let out = summary(&space);
    store.data.spaces.push(space);
    store.save()?;
    Ok(out)
}

#[tauri::command]
fn update_space(
    st: State<AppStore>,
    id: String,
    name: Option<String>,
    description: Option<String>,
    color: Option<String>,
) -> Result<()> {
    let mut store = lock(&st)?;
    let s = store.space_mut(&id)?;
    if let Some(n) = name {
        let n = n.trim();
        if n.is_empty() {
            return Err(Error::EmptyName);
        }
        s.name = n.to_string();
    }
    if let Some(d) = description {
        s.description = d;
    }
    if let Some(c) = color {
        s.color = c;
    }
    store.save()
}

#[tauri::command]
fn delete_space(st: State<AppStore>, id: String) -> Result<()> {
    let mut store = lock(&st)?;
    let before = store.data.spaces.len();
    store.data.spaces.retain(|s| s.id != id);
    if store.data.spaces.len() == before {
        return Err(Error::SpaceNotFound);
    }
    store.save()
}

/// Adds references to the given paths. Nothing on disk is moved or copied.
#[tauri::command]
async fn add_paths(st: State<'_, AppStore>, space_id: String, paths: Vec<String>) -> Result<AddResult> {
    let paths: Vec<String> = paths.iter().map(|p| net::normalize(p)).collect();
    let probes = blocking(move || net::probe_all(&paths)).await?;

    let mut store = lock(&st)?;
    let s = store.space_mut(&space_id)?;
    let mut res = AddResult { added: 0, duplicates: 0, missing: vec![], offline: vec![] };
    let mut keys: std::collections::HashSet<String> = s.items.iter().map(|i| net::path_key(&i.path)).collect();
    for p in probes {
        match p.status {
            Status::Missing => res.missing.push(p.path),
            Status::Offline => res.offline.push(p.path),
            Status::Ok if !keys.insert(net::path_key(&p.path)) => res.duplicates += 1,
            Status::Ok => {
                s.items.push(Item {
                    id: uuid::Uuid::new_v4().to_string(),
                    kind: if p.is_dir { Kind::Folder } else { Kind::File },
                    path: p.path,
                    label: None,
                    note: String::new(),
                    tags: vec![],
                    added_at: now_ms(),
                });
                res.added += 1;
            }
        }
    }
    if res.added > 0 {
        store.save()?;
    }
    Ok(res)
}

#[tauri::command]
fn remove_item(st: State<AppStore>, space_id: String, item_id: String) -> Result<()> {
    let mut store = lock(&st)?;
    let s = store.space_mut(&space_id)?;
    let before = s.items.len();
    s.items.retain(|i| i.id != item_id);
    if s.items.len() == before {
        return Err(Error::ItemNotFound);
    }
    store.save()
}

#[tauri::command]
fn update_item(
    st: State<AppStore>,
    space_id: String,
    item_id: String,
    label: Option<String>,
    note: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<()> {
    let mut store = lock(&st)?;
    let item = store.space_mut(&space_id)?.item_mut(&item_id)?;
    if let Some(t) = tags {
        item.tags = normalize_tags(t);
    }
    if let Some(l) = label {
        let l = l.trim();
        item.label = (!l.is_empty()).then(|| l.to_string());
    }
    if let Some(n) = note {
        item.note = n;
    }
    store.save()
}

/// Points an item at a new location after the original was moved or renamed.
#[tauri::command]
async fn relink_item(st: State<'_, AppStore>, space_id: String, item_id: String, new_path: String) -> Result<()> {
    let new_path = net::normalize(&new_path);
    let p = new_path.clone();
    let probe = blocking(move || net::probe_all(&[p]).remove(0)).await?;
    if probe.status != Status::Ok {
        return Err(Error::PathMissing(new_path));
    }
    let mut store = lock(&st)?;
    let item = store.space_mut(&space_id)?.item_mut(&item_id)?;
    item.path = new_path;
    item.kind = if probe.is_dir { Kind::Folder } else { Kind::File };
    store.save()
}

/// Searches item names, labels, notes and paths across all spaces.
#[tauri::command]
fn search(st: State<AppStore>, query: String) -> Result<Vec<SearchHit>> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let store = lock(&st)?;
    let mut hits = vec![];
    for s in &store.data.spaces {
        for i in &s.items {
            let hay = format!(
                "{} {} {} {}",
                i.path.to_lowercase(),
                i.label.as_deref().unwrap_or("").to_lowercase(),
                i.note.to_lowercase(),
                i.tags.join(" ").to_lowercase()
            );
            if hay.contains(&q) {
                hits.push(SearchHit {
                    space_id: s.id.clone(),
                    space_name: s.name.clone(),
                    space_color: s.color.clone(),
                    item: view_item(i),
                });
            }
        }
    }
    Ok(hits)
}

/// All tags in use, with the number of items carrying them. Case-insensitive; the first
/// spelling encountered is shown.
fn tag_counts(spaces: &[Space]) -> Vec<TagCount> {
    let mut map: std::collections::HashMap<String, TagCount> = std::collections::HashMap::new();
    for t in spaces.iter().flat_map(|s| &s.items).flat_map(|i| &i.tags) {
        map.entry(t.to_lowercase())
            .or_insert_with(|| TagCount { name: t.clone(), count: 0 })
            .count += 1;
    }
    let mut v: Vec<(String, TagCount)> = map.into_iter().collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    v.into_iter().map(|(_, t)| t).collect()
}

#[tauri::command]
fn list_tags(st: State<AppStore>) -> Result<Vec<TagCount>> {
    Ok(tag_counts(&lock(&st)?.data.spaces))
}

/// Items across all spaces that carry the given tag (case-insensitive).
#[tauri::command]
fn items_by_tag(st: State<AppStore>, tag: String) -> Result<Vec<SearchHit>> {
    let key = tag.trim().to_lowercase();
    let store = lock(&st)?;
    Ok(store
        .data
        .spaces
        .iter()
        .flat_map(|s| s.items.iter().map(move |i| (s, i)))
        .filter(|(_, i)| i.tags.iter().any(|t| t.to_lowercase() == key))
        .map(|(s, i)| SearchHit {
            space_id: s.id.clone(),
            space_name: s.name.clone(),
            space_color: s.color.clone(),
            item: view_item(i),
        })
        .collect())
}

// ---------- commands: storage location ----------

fn target_file(cfg: &Config, dir: Option<String>) -> PathBuf {
    match dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(net::normalize(&d)).join(DATA_FILE),
        None => cfg.default_data_file.clone(),
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    net::path_key(&a.to_string_lossy()) == net::path_key(&b.to_string_lossy())
}

fn storage_info_of(store: &Store, cfg: &Config) -> Result<StorageInfo> {
    Ok(StorageInfo {
        path: store.file().display().to_string(),
        default_path: cfg.default_data_file.display().to_string(),
        is_default: same_file(store.file(), &cfg.default_data_file),
        warning: cfg.startup_warning.lock().map_err(|_| Error::Other("lock poisoned".into()))?.clone(),
    })
}

/// Checks that the folder of `file` is reachable (with the network timeout), then reads it.
fn load_reachable(file: &Path) -> Result<store::Data> {
    let dir = file.parent().map(|d| d.display().to_string()).unwrap_or_default();
    match net::probe_all(std::slice::from_ref(&dir)).remove(0).status {
        Status::Ok => read_data(file),
        Status::Offline => Err(Error::Other(format!("Netzwerkfreigabe nicht erreichbar: {dir}"))),
        Status::Missing => Err(Error::PathMissing(dir)),
    }
}

#[tauri::command]
fn storage_info(st: State<AppStore>, cfg: State<Config>) -> Result<StorageInfo> {
    let store = lock(&st)?;
    storage_info_of(&store, &cfg)
}

/// What is at the given folder (`None` = default location) before switching to it.
#[tauri::command]
async fn inspect_location(cfg: State<'_, Config>, dir: Option<String>) -> Result<LocationCheck> {
    let file = target_file(&cfg, dir);
    blocking(move || {
        let path = file.display().to_string();
        let dir = file.parent().map(|d| d.display().to_string()).unwrap_or_default();
        // A missing folder is fine: it is created on save. An unreachable share is not.
        if net::probe_all(std::slice::from_ref(&dir)).remove(0).status == Status::Offline {
            return Err(Error::Other(format!("Netzwerkfreigabe nicht erreichbar: {dir}")));
        }
        if !file.exists() {
            return Ok(LocationCheck { path, exists: false, spaces: None, error: None });
        }
        Ok(match read_data(&file) {
            Ok(d) => LocationCheck { path, exists: true, spaces: Some(d.spaces.len()), error: None },
            Err(e) => LocationCheck { path, exists: true, spaces: None, error: Some(e.to_string()) },
        })
    })
    .await?
}

/// Moves the data file to `dir` (`None` = default location).
/// `use_existing`: load the file already there instead of overwriting it with the current data.
/// When overwriting, an existing file is kept as `spaces.json.bak`. The old file stays untouched.
#[tauri::command]
async fn change_location(app: AppHandle, dir: Option<String>, use_existing: bool) -> Result<StorageInfo> {
    blocking(move || {
        let cfg = app.state::<Config>();
        let st = app.state::<AppStore>();
        let file = target_file(&cfg, dir);
        let mut store = lock(&st)?;
        if !same_file(store.file(), &file) {
            let data = if use_existing && file.exists() {
                load_reachable(&file)?
            } else {
                if file.exists() {
                    std::fs::copy(&file, file.with_extension("json.bak"))?;
                }
                let data = store::Data { version: store.data.version, spaces: store.data.spaces.clone() };
                write_data(&file, &data)?;
                data
            };
            store.relocate(file.clone(), data);
        }
        let is_default = same_file(&file, &cfg.default_data_file);
        Settings { data_file: (!is_default).then(|| file.display().to_string()) }.save(&cfg.settings_file)?;
        if let Ok(mut w) = cfg.startup_warning.lock() {
            *w = None;
        }
        storage_info_of(&store, &cfg)
    })
    .await?
}

// ---------- commands: file system (never on the main thread) ----------

/// Existence, size and date for the given paths. Unreachable shares yield `offline` quickly.
#[tauri::command]
async fn probe(paths: Vec<String>) -> Result<Vec<Probe>> {
    blocking(move || net::probe_all(&paths)).await
}

/// Missing/offline counts per space, for the sidebar.
#[tauri::command]
async fn space_health(st: State<'_, AppStore>) -> Result<Vec<SpaceHealth>> {
    let spaces: Vec<(String, Vec<String>)> = lock(&st)?
        .data
        .spaces
        .iter()
        .map(|s| (s.id.clone(), s.items.iter().map(|i| i.path.clone()).collect()))
        .collect();
    blocking(move || {
        let all: Vec<String> = spaces.iter().flat_map(|(_, p)| p.iter().cloned()).collect();
        let mut probes = net::probe_all(&all).into_iter();
        spaces
            .into_iter()
            .map(|(id, paths)| {
                let mut h = SpaceHealth { space_id: id, missing: 0, offline: 0 };
                for p in probes.by_ref().take(paths.len()) {
                    match p.status {
                        Status::Missing => h.missing += 1,
                        Status::Offline => h.offline += 1,
                        Status::Ok => {}
                    }
                }
                h
            })
            .collect()
    })
    .await
}

/// Copies the referenced files/folders themselves to the clipboard (paste with Ctrl+V in Explorer).
/// Missing originals and those on unreachable shares are skipped.
#[tauri::command]
async fn copy_files(paths: Vec<String>) -> Result<CopyResult> {
    blocking(move || {
        let probes = net::probe_all(&paths);
        let ok: Vec<String> = probes.iter().filter(|p| p.status == Status::Ok).map(|p| p.path.clone()).collect();
        let count = |s| probes.iter().filter(|p| p.status == s).count();
        let res = CopyResult { copied: ok.len(), missing: count(Status::Missing), offline: count(Status::Offline) };
        if ok.is_empty() {
            return Err(Error::Other(if res.offline > 0 {
                "Die Netzwerkfreigabe ist nicht erreichbar".into()
            } else {
                "Keine der gewählten Dateien ist auffindbar".into()
            }));
        }
        clipboard::set_files(&ok).map_err(Error::Other)?;
        Ok(res)
    })
    .await?
}

/// Copies the full paths as text, one per line.
#[tauri::command]
fn copy_paths(paths: Vec<String>) -> Result<()> {
    clipboard::set_text(&paths.join("\r\n")).map_err(Error::Other)
}

#[tauri::command]
async fn open_path(path: String) -> Result<()> {
    blocking(move || tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| Error::Other(e.to_string())))
        .await?
}

#[tauri::command]
async fn reveal_path(path: String) -> Result<()> {
    blocking(move || tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| Error::Other(e.to_string())))
        .await?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let default_data_file = app.path().app_data_dir()?.join(DATA_FILE);
            let settings_file = app.path().app_config_dir()?.join("settings.json");
            let custom = Settings::load(&settings_file)
                .data_file
                .map(PathBuf::from)
                .filter(|f| !same_file(f, &default_data_file));
            // A custom location that cannot be read (share offline, folder gone, corrupt file)
            // must not block the app: fall back to the default and say so in the UI.
            let (store, warning) = match custom {
                Some(f) => match load_reachable(&f) {
                    Ok(data) => (Store::new(f.clone(), data), None),
                    Err(e) => (
                        Store::load(default_data_file.clone())?,
                        Some(format!("Datendatei {} konnte nicht geladen werden ({e}). Es wird vorübergehend der Standardspeicherort verwendet.", f.display())),
                    ),
                },
                None => (Store::load(default_data_file.clone())?, None),
            };
            app.manage::<AppStore>(Mutex::new(store));
            app.manage(Config { settings_file, default_data_file, startup_warning: Mutex::new(warning) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_spaces,
            get_space,
            create_space,
            update_space,
            delete_space,
            add_paths,
            remove_item,
            update_item,
            relink_item,
            search,
            list_tags,
            items_by_tag,
            probe,
            space_health,
            copy_files,
            copy_paths,
            open_path,
            reveal_path,
            storage_info,
            inspect_location,
            change_location
        ])
        .run(tauri::generate_context!())
        .expect("error while running OneSpace");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(tags: &[&str]) -> Item {
        Item {
            id: uuid::Uuid::new_v4().to_string(),
            path: "C:\\x".into(),
            kind: Kind::File,
            label: None,
            note: String::new(),
            tags: tags.iter().map(|t| t.to_string()).collect(),
            added_at: 0,
        }
    }

    #[test]
    fn tag_counts_merge_case_and_spaces() {
        let space = |items| Space {
            id: "s".into(),
            name: "n".into(),
            description: String::new(),
            color: "#000".into(),
            created_at: 0,
            items,
        };
        let spaces = vec![
            space(vec![item(&["Rechnung", "Kunde"]), item(&["rechnung"])]),
            space(vec![item(&["Angebot"]), item(&[])]),
        ];
        let counts: Vec<(String, usize)> = tag_counts(&spaces).into_iter().map(|t| (t.name, t.count)).collect();
        assert_eq!(
            counts,
            vec![("Angebot".into(), 1), ("Kunde".into(), 1), ("Rechnung".into(), 2)]
        );
    }
}
