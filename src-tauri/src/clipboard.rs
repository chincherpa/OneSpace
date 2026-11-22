//! Windows clipboard: put real files (CF_HDROP, like Ctrl+C in Explorer) or plain text.

#[cfg(windows)]
mod imp {
    use clipboard_win::{options::NoClear, raw, Clipboard};

    fn open() -> Result<Clipboard, String> {
        let clip = Clipboard::new_attempts(10).map_err(|e| format!("Zwischenablage belegt: {e}"))?;
        raw::empty().map_err(|e| e.to_string())?;
        Ok(clip)
    }

    /// Files for pasting in Explorer/Outlook etc., plus the paths as text for editors.
    pub fn set_files(paths: &[String]) -> Result<(), String> {
        let _clip = open()?;
        raw::set_file_list_with(paths, NoClear).map_err(|e| e.to_string())?;
        // Tell Explorer that a paste should copy (DROPEFFECT_COPY), never move.
        if let Some(fmt) = raw::register_format("Preferred DropEffect") {
            raw::set_without_clear(fmt.get(), &1u32.to_le_bytes()).map_err(|e| e.to_string())?;
        }
        raw::set_string_with(&paths.join("\r\n"), NoClear).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_text(text: &str) -> Result<(), String> {
        let _clip = open()?;
        raw::set_string_with(text, NoClear).map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn set_files(_: &[String]) -> Result<(), String> {
        Err("Zwischenablage wird nur unter Windows unterstützt".into())
    }
    pub fn set_text(_: &str) -> Result<(), String> {
        Err("Zwischenablage wird nur unter Windows unterstützt".into())
    }
}

pub use imp::{set_files, set_text};
