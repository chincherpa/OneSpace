mod clipboard;
mod net;
mod store;

use net::{Probe, Status};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use store::{now_ms, Error, Item, Kind, Result, Space, Store};
use tauri::{Manager, State};

type AppStore = Mutex<Store>;

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
) -> Result<()> {
    let mut store = lock(&st)?;
    let item = store.space_mut(&space_id)?.item_mut(&item_id)?;
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
                "{} {} {}",
                i.path.to_lowercase(),
                i.label.as_deref().unwrap_or("").to_lowercase(),
                i.note.to_lowercase()
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
            let file = app.path().app_data_dir()?.join("spaces.json");
            app.manage::<AppStore>(Mutex::new(Store::load(file)?));
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
            probe,
            space_health,
            copy_files,
            copy_paths,
            open_path,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running OneSpace");
}
