//! Persistent "map" of spaces: only paths and metadata are stored, never file contents.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Space not found")]
    SpaceNotFound,
    #[error("Item not found")]
    ItemNotFound,
    #[error("Name must not be empty")]
    EmptyName,
    #[error("Path does not exist: {0}")]
    PathMissing(String),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Data file is corrupt: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    File,
    Folder,
}

/// A reference to something on disk. The original is never touched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub path: String,
    pub kind: Kind,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub note: String,
    /// Free keywords ("tags"), unique case-insensitively, in the order entered.
    #[serde(default)]
    pub tags: Vec<String>,
    pub added_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Space {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub color: String,
    pub created_at: u64,
    #[serde(default)]
    pub items: Vec<Item>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Data {
    pub version: u32,
    pub spaces: Vec<Space>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub struct Store {
    file: PathBuf,
    pub data: Data,
}

/// Reads a data file; a missing file yields an empty map.
pub fn read_data(file: &Path) -> Result<Data> {
    match fs::read_to_string(file) {
        Ok(s) => Ok(serde_json::from_str(&s)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Data { version: 1, spaces: vec![] }),
        Err(e) => Err(e.into()),
    }
}

/// Atomic write: a temp file next to the target, then rename over it.
pub fn write_data(file: &Path, data: &Data) -> Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = file.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(data)?)?;
    fs::rename(&tmp, file)?;
    Ok(())
}

impl Store {
    pub fn load(file: PathBuf) -> Result<Self> {
        let data = read_data(&file)?;
        Ok(Self { file, data })
    }

    pub fn new(file: PathBuf, data: Data) -> Self {
        Self { file, data }
    }

    pub fn save(&self) -> Result<()> {
        write_data(&self.file, &self.data)
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    /// Switches to another data file. `data` is what that file now holds.
    pub fn relocate(&mut self, file: PathBuf, data: Data) {
        self.file = file;
        self.data = data;
    }

    pub fn space_mut(&mut self, id: &str) -> Result<&mut Space> {
        self.data.spaces.iter_mut().find(|s| s.id == id).ok_or(Error::SpaceNotFound)
    }

    pub fn space(&self, id: &str) -> Result<&Space> {
        self.data.spaces.iter().find(|s| s.id == id).ok_or(Error::SpaceNotFound)
    }
}

/// App settings, stored separately from the data so the data file can live anywhere.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Custom location of the data file; `None` means the default in the app data folder.
    #[serde(default)]
    pub data_file: Option<String>,
}

impl Settings {
    /// Missing or unreadable settings fall back to the defaults.
    pub fn load(file: &Path) -> Self {
        fs::read_to_string(file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> Result<()> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = file.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        fs::rename(&tmp, file)?;
        Ok(())
    }
}

/// Trims and collapses whitespace, drops empty entries and leading '#',
/// removes case-insensitive duplicates (first spelling wins).
pub fn normalize_tags<I: IntoIterator<Item = S>, S: AsRef<str>>(tags: I) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = vec![];
    for t in tags {
        let t = t.as_ref().trim().trim_start_matches('#');
        let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
        if !t.is_empty() && seen.insert(t.to_lowercase()) {
            out.push(t);
        }
    }
    out
}

impl Space {
    pub fn item_mut(&mut self, id: &str) -> Result<&mut Item> {
        self.items.iter_mut().find(|i| i.id == id).ok_or(Error::ItemNotFound)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_dedupe() {
        let dir = std::env::temp_dir().join(format!("onespace-test-{}", uuid::Uuid::new_v4()));
        let file = dir.join("spaces.json");
        let mut store = Store::load(file.clone()).unwrap();
        store.data.spaces.push(Space {
            id: "s1".into(),
            name: "Test".into(),
            description: String::new(),
            color: "#000".into(),
            created_at: 0,
            items: vec![Item {
                id: "i1".into(),
                path: "C:\\Users\\a\\Documents\\x.xlsx".into(),
                kind: Kind::File,
                label: None,
                note: String::new(),
                tags: vec!["Rechnung".into()],
                added_at: 0,
            }],
        });
        store.save().unwrap();
        let loaded = Store::load(file).unwrap();
        assert_eq!(loaded.data.spaces.len(), 1);
        assert_eq!(loaded.data.spaces[0].items[0].path, "C:\\Users\\a\\Documents\\x.xlsx");
        assert_eq!(loaded.data.spaces[0].items[0].tags, vec!["Rechnung".to_string()]);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn old_files_without_tags_load() {
        let json = r##"{"version":1,"spaces":[{"id":"s","name":"n","color":"#000","createdAt":0,
            "items":[{"id":"i","path":"C:\\x","kind":"file","addedAt":0}]}]}"##;
        let data: Data = serde_json::from_str(json).unwrap();
        assert!(data.spaces[0].items[0].tags.is_empty());
    }

    #[test]
    fn settings_roundtrip_and_defaults() {
        let dir = std::env::temp_dir().join(format!("onespace-test-{}", uuid::Uuid::new_v4()));
        let file = dir.join("settings.json");
        assert!(Settings::load(&file).data_file.is_none());
        Settings { data_file: Some("D:\\Daten\\spaces.json".into()) }.save(&file).unwrap();
        assert_eq!(Settings::load(&file).data_file.as_deref(), Some("D:\\Daten\\spaces.json"));
        fs::write(&file, "kaputt").unwrap();
        assert!(Settings::load(&file).data_file.is_none());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn tags_are_normalized() {
        assert_eq!(
            normalize_tags(["  Rechnung ", "#rechnung", "", "Kunde   A", "kunde a", "2026"]),
            vec!["Rechnung", "Kunde A", "2026"]
        );
    }
}
