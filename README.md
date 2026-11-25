# OneSpace

Windows-Desktop-App (Tauri 2): Lege für jedes Projekt einen **Space** an und führe Dateien, Ordner und Ressourcen von überall auf dem PC zusammen, aus Dokumente, Downloads, OneDrive, Desktop oder anderen Projektordnern, **ohne die Originale zu verschieben oder zu kopieren**.

> Speichert die Karte, nicht die Dateien.

## Funktionen

- Spaces anlegen, umbenennen, beschreiben, einfärben, löschen. Beim Löschen werden nur die Verknüpfungen entfernt, nie Dateien.
- Dateien/Ordner per **Drag & Drop aus dem Explorer** hinzufügen. Wer auf einen Space in der Seitenleiste zieht, fügt die Elemente direkt dort hinzu. Alternativ geht es über die Dateiauswahl.
- Jede Verknüpfung zeigt ihren Herkunftsort (Dokumente, Downloads, OneDrive …), Größe und Änderungsdatum.
- Elemente öffnen (Doppelklick) oder im Explorer anzeigen.
- **In die Zwischenablage kopieren:** einzeln über das Kopier-Symbol oder per Mehrfachauswahl (Klick, Strg+Klick, Umschalt+Klick, Strg+A) und **Strg+C**. Kopiert werden die echten Dateien/Ordner, wie im Explorer. Mit Strg+V lassen sie sich im Explorer, in Outlook, Teams usw. einfügen, in Texteditoren als Pfade. **Strg+Umschalt+C** bzw. „Pfade kopieren“ kopiert nur die Pfade als Text. Jedes Element hat dafür zusätzlich ein eigenes Symbol „Pfad kopieren“ (auch bei nicht gefundenen Dateien und in den Suchtreffern).
- Eigene Bezeichnung und Notiz pro Element, zum Beispiel welche Rolle es im Projekt spielt.
- **Tags:** Jedes Element kann beliebig viele Schlagwörter bekommen (Stift-Symbol, kommagetrennt; vorhandene Tags lassen sich per Klick übernehmen). Groß-/Kleinschreibung spielt keine Rolle, `#rechnung` und `Rechnung` sind dasselbe Tag.
- **Dashboard** (Startseite): listet alle Tags mit Anzahl. Ein Klick auf ein Tag zeigt alle Elemente damit, über alle Spaces hinweg, mit denselben Aktionen wie im Space (öffnen, kopieren, im Explorer zeigen, Pfad kopieren, bearbeiten, entfernen, Mehrfachauswahl, Filter, Sortierung) und einem Link zum jeweiligen Space. Tags an einem Element sind ebenfalls anklickbar und führen dorthin.
- Erkennung verschobener oder gelöschter Originale („Nicht gefunden“) und **Neu verknüpfen**.
- **Netzwerkordner:** UNC-Pfade (`\\server\freigabe\…`) und verbundene Netzlaufwerke (`Z:\…`) werden erkannt und als „Netzwerk · server\freigabe“ angezeigt. `Z:\a.pdf` und `\\server\freigabe\a.pdf` gelten als dieselbe Datei.
- Ist eine Freigabe nicht erreichbar (VPN aus, NAS im Ruhezustand), zeigt die App **„Offline“** statt „Nicht gefunden“ und friert nicht ein. Alle Dateisystem-Prüfungen laufen im Hintergrund, mit 2 s Timeout pro Freigabe. Das Ergebnis wird 30 s zwischengespeichert.
- Filtern/Sortieren innerhalb eines Space, Suche über alle Spaces („In welchem Projekt war diese Datei?“). Beides berücksichtigt auch Tags.
- Doppelte Pfade werden erkannt, unter Windows ohne Beachtung der Groß-/Kleinschreibung.
- Helles und dunkles Design, je nach Windows-Einstellung.

## Datenhaltung

Alle Spaces liegen als JSON in `%APPDATA%\com.onespace.app\spaces.json`. Gespeichert werden nur Pfade und Metadaten. Das Schreiben ist atomar (temporäre Datei + Rename).

## Entwicklung (Windows)

Voraussetzungen: [Rust](https://rustup.rs), Node 22, pnpm, WebView2 (in Windows 10/11 enthalten), Visual Studio Build Tools (C++).

```powershell
pnpm install
pnpm tauri dev      # App mit Hot-Reload starten
pnpm tauri build    # Installer (.exe/.msi) unter src-tauri\target\release\bundle\
cargo test --manifest-path src-tauri/Cargo.toml
```

Ohne lokale Toolchain baut der GitHub-Workflow **Windows build** bei jedem Push den Installer. Er liegt dann unter *Actions → Lauf → Artifacts → OneSpace-windows*.

## Aufbau

| Pfad | Inhalt |
| --- | --- |
| `src-tauri/src/store.rs` | Datenmodell (Space, Item), Laden/Speichern |
| `src-tauri/src/net.rs` | UNC/Netzlaufwerke, Dateisystem-Prüfung mit Timeout |
| `src-tauri/src/lib.rs` | Tauri-Commands: CRUD, Suche, Tags, Öffnen/Explorer, Herkunftsort |
| `src/api.ts` | Typisierte Wrapper um `invoke` |
| `src/main.ts` | UI (Vanilla TS), Drag & Drop, Dialoge |
| `src/styles.css` | Styles inkl. Dark Mode |
