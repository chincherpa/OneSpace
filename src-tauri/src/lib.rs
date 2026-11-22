mod clipboard;
mod store;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use store::{kind_of, now_ms, Error, Item, Kind, Result, Space, Store};
use tauri::{Manager, State};

type AppStore = Mutex<Store>;

const PALETTE: &[&str] = &[
    "#4f7cff", "#16a37f", "#e2683c", "#a35bd6", "#d4a017", "#d6457a", "#2e9bc4", "#6b7a8f",
];

// ---------- view models (computed from the file system on demand) ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SpaceSummary {
    id: String,
    name: String,
    color: String,
    item_count: usize,
    missing_count: usize,
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
    exists: bool,
    size: Option<u64>,
    modified: Option<u64>,
    extension: String,
    /// Human readable origin, e.g. "Dokumente", "Downloads", "OneDrive".
    location: String,
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchHit {
    space_id: String,
    space_name: String,
    space_color: String,
    item: ItemView,
}

fn known_locations() -> Vec<(String, PathBuf)> {
    let mut v: Vec<(String, PathBuf)> = Vec::new();
    // OneDrive first: Documents/Desktop are often redirected into it.
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
    ];
    for (name, dir) in dirs {
        if let Some(d) = dir {
            v.push((name.into(), d));
        }
    }
    if let Some(h) = dirs::home_dir() {
        v.push(("Benutzerordner".into(), h));
    }
    // Most specific (longest) match wins.
    v.sort_by_key(|(_, p)| std::cmp::Reverse(p.as_os_str().len()));
    v
}

fn location_of(path: &Path, known: &[(String, PathBuf)]) -> String {
    let key = store::path_key(&path.to_string_lossy());
    for (name, dir) in known {
        let dk = store::path_key(&dir.to_string_lossy());
        if key.starts_with(&dk) && key.len() > dk.len() {
            return name.clone();
        }
    }
    // Fall back to the drive (Windows) or the top-level folder.
    path.components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().trim_end_matches(['\\', ':']).to_string() + ":")
        .unwrap_or_default()
}

fn view_item(item: &Item, known: &[(String, PathBuf)]) -> ItemView {
    let p = Path::new(&item.path);
    let meta = fs::metadata(p).ok();
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| item.path.clone());
    ItemView {
        id: item.id.clone(),
        path: item.path.clone(),
        kind: item.kind,
        name,
        label: item.label.clone(),
        note: item.note.clone(),
        added_at: item.added_at,
        exists: meta.is_some(),
        size: meta.as_ref().filter(|m| m.is_file()).map(|m| m.len()),
        modified: meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64),
        extension: p
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default(),
        location: location_of(p, known),
        parent: p.parent().map(|x| x.display().to_string()).unwrap_or_default(),
    }
}

fn summary(s: &Space) -> SpaceSummary {
    SpaceSummary {
        id: s.id.clone(),
        name: s.name.clone(),
        color: s.color.clone(),
        item_count: s.items.len(),
        missing_count: s.items.iter().filter(|i| !Path::new(&i.path).exists()).count(),
    }
}

fn lock<'a>(st: &'a State<AppStore>) -> Result<std::sync::MutexGuard<'a, Store>> {
    st.lock().map_err(|_| Error::Other("store lock poisoned".into()))
}

// ---------- commands ----------

#[tauri::command]
fn list_spaces(st: State<AppStore>) -> Result<Vec<SpaceSummary>> {
    Ok(lock(&st)?.data.spaces.iter().map(summary).collect())
}

#[tauri::command]
fn get_space(st: State<AppStore>, id: String) -> Result<SpaceView> {
    let store = lock(&st)?;
    let s = store.space(&id)?;
    let known = known_locations();
    Ok(SpaceView {
        id: s.id.clone(),
        name: s.name.clone(),
        description: s.description.clone(),
        color: s.color.clone(),
        created_at: s.created_at,
        items: s.items.iter().map(|i| view_item(i, &known)).collect(),
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
fn add_paths(st: State<AppStore>, space_id: String, paths: Vec<String>) -> Result<AddResult> {
    let mut store = lock(&st)?;
    let s = store.space_mut(&space_id)?;
    let mut res = AddResult { added: 0, duplicates: 0, missing: vec![] };
    for raw in paths {
        let p = PathBuf::from(&raw);
        let kind = match kind_of(&p) {
            Ok(k) => k,
            Err(_) => {
                res.missing.push(raw);
                continue;
            }
        };
        if s.contains_path(&raw) {
            res.duplicates += 1;
            continue;
        }
        s.items.push(Item {
            id: uuid::Uuid::new_v4().to_string(),
            path: raw,
            kind,
            label: None,
            note: String::new(),
            added_at: now_ms(),
        });
        res.added += 1;
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
fn relink_item(st: State<AppStore>, space_id: String, item_id: String, new_path: String) -> Result<()> {
    let kind = kind_of(Path::new(&new_path))?;
    let mut store = lock(&st)?;
    let item = store.space_mut(&space_id)?.item_mut(&item_id)?;
    item.path = new_path;
    item.kind = kind;
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
    let known = known_locations();
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
                    item: view_item(i, &known),
                });
            }
        }
    }
    Ok(hits)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CopyResult {
    copied: usize,
    missing: usize,
}

/// Copies the referenced files/folders themselves to the clipboard (paste with Ctrl+V in Explorer).
/// Missing originals are skipped.
#[tauri::command]
fn copy_files(paths: Vec<String>) -> Result<CopyResult> {
    let (ok, missing): (Vec<String>, Vec<String>) = paths.into_iter().partition(|p| Path::new(p).exists());
    if ok.is_empty() {
        return Err(Error::Other("Keine der gewählten Dateien ist auffindbar".into()));
    }
    clipboard::set_files(&ok).map_err(Error::Other)?;
    Ok(CopyResult { copied: ok.len(), missing: missing.len() })
}

/// Copies the full paths as text, one per line.
#[tauri::command]
fn copy_paths(paths: Vec<String>) -> Result<()> {
    clipboard::set_text(&paths.join("\r\n")).map_err(Error::Other)
}

#[tauri::command]
fn open_path(path: String) -> Result<()> {
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| Error::Other(e.to_string()))
}

#[tauri::command]
fn reveal_path(path: String) -> Result<()> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| Error::Other(e.to_string()))
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
            open_path,
            copy_files,
            copy_paths,
            reveal_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running OneSpace");
}
