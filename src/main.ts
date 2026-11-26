import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open } from "@tauri-apps/plugin-dialog";
import {
  api,
  type ItemView,
  type Probe,
  type SearchHit,
  type SpaceHealth,
  type SpaceSummary,
  type SpaceView,
  type StorageInfo,
  type TagCount,
} from "./api";

const COLORS = [
  "#4f7cff", "#2e9bc4", "#16a37f", "#5f9e2f", "#d4a017", "#e2683c",
  "#d6453d", "#d6457a", "#a35bd6", "#6d5bd6", "#8a6d3b", "#6b7a8f",
];

type SortKey = "added" | "name" | "location" | "modified";
type SpaceSort = "oldest" | "newest" | "name";
type Theme = "system" | "light" | "dark";

// ---------- per-user preferences (UI only; the data file holds the spaces) ----------

function pref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(`onespace.${key}`) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function savePref(key: string, value: string) {
  try {
    localStorage.setItem(`onespace.${key}`, value);
  } catch {
    /* storage unavailable: preference lasts for this session only */
  }
}

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function applyTheme(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

const isDark = () => (state.theme === "system" ? darkQuery.matches : state.theme === "dark");

const state = {
  spaces: [] as SpaceSummary[],
  current: null as SpaceView | null,
  filter: "",
  sort: "added" as SortKey,
  spaceSort: pref<SpaceSort>("spaceSort", ["oldest", "newest", "name"], "oldest"),
  theme: pref<Theme>("theme", ["system", "light", "dark"], "system"),
  /** Main area shows the settings page. */
  settings: false,
  storage: null as StorageInfo | null,
  /** Space whose color popover is open; "header" variant is keyed by `colorPickerAt`. */
  colorPicker: null as string | null,
  colorPickerAt: "sidebar" as "sidebar" | "header",
  /** Space being renamed inline in the sidebar. */
  renaming: null as string | null,
  globalQuery: "",
  hits: [] as SearchHit[],
  /** Dashboard: all tags, the chosen one and the items carrying it. */
  tags: [] as TagCount[],
  activeTag: null as string | null,
  tagHits: [] as SearchHit[],
  editingItem: null as string | null,
  creating: false,
  dragging: false,
  dropTarget: null as string | null,
  selected: new Set<string>(),
  anchor: null as string | null,
  /** File-system state per path; filled asynchronously so the UI never waits on slow shares. */
  probes: new Map<string, Probe>(),
  health: new Map<string, SpaceHealth>(),
};

type ItemStatus = Probe["status"] | "unknown";
const statusOf = (i: ItemView): ItemStatus => state.probes.get(i.path)?.status ?? "unknown";

const app = document.getElementById("app")!;

// ---------- helpers ----------

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function fmtSize(n: number | null): string {
  if (n == null) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

const fmtDate = (ms: number | null) =>
  ms ? new Date(ms).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";

const BADGES: Record<string, [string, string]> = {
  pdf: ["PDF", "#d6453d"],
  xlsx: ["XLS", "#1d8f4e"], xls: ["XLS", "#1d8f4e"], csv: ["CSV", "#1d8f4e"],
  docx: ["DOC", "#2f62c8"], doc: ["DOC", "#2f62c8"], txt: ["TXT", "#6b7a8f"], md: ["MD", "#6b7a8f"],
  pptx: ["PPT", "#d2632b"], ppt: ["PPT", "#d2632b"],
  png: ["IMG", "#a35bd6"], jpg: ["IMG", "#a35bd6"], jpeg: ["IMG", "#a35bd6"], gif: ["IMG", "#a35bd6"], svg: ["SVG", "#a35bd6"],
  zip: ["ZIP", "#8a6d3b"], "7z": ["ZIP", "#8a6d3b"], rar: ["ZIP", "#8a6d3b"],
  py: ["PY", "#3572a5"], ts: ["TS", "#3178c6"], js: ["JS", "#b59a00"], json: ["JSON", "#6b7a8f"],
  mp4: ["VID", "#c2410c"], mov: ["VID", "#c2410c"], mp3: ["AUD", "#0e7490"], wav: ["AUD", "#0e7490"],
  lnk: ["LNK", "#6b7a8f"], exe: ["EXE", "#6b7a8f"],
};

function iconFor(item: ItemView): string {
  if (item.kind === "folder") {
    return `<span class="icon folder" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/></svg></span>`;
  }
  const [txt, color] = BADGES[item.extension] ?? [item.extension.slice(0, 4).toUpperCase() || "FILE", "#6b7a8f"];
  return `<span class="icon file" style="--c:${color}" aria-hidden="true">${esc(txt)}</span>`;
}

let toastTimer: number | undefined;
function toast(msg: string, kind: "ok" | "err" = "ok", ms = 3200) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.className = `toast show ${kind}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), ms);
}

async function guard<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    toast(String(e), "err");
    return undefined;
  }
}

// ---------- data flow ----------

async function refresh() {
  state.spaces = (await guard(api.listSpaces())) ?? [];
  if (state.current) {
    state.current = (await guard(api.getSpace(state.current.id))) ?? null;
  }
  if (state.globalQuery) state.hits = (await guard(api.search(state.globalQuery))) ?? [];
  await loadTags();
  render();
  void probeVisible();
  void loadHealth();
}

async function loadTags() {
  state.tags = (await guard(api.listTags())) ?? [];
  const active = state.activeTag?.toLowerCase();
  if (active && !state.tags.some((t) => t.name.toLowerCase() === active)) state.activeTag = null;
  state.tagHits = state.activeTag ? ((await guard(api.itemsByTag(state.activeTag))) ?? []) : [];
}

/** Opens the dashboard, optionally with a tag selected. */
async function showDashboard(tag: string | null = state.activeTag) {
  state.current = null;
  state.settings = false;
  state.globalQuery = "";
  state.hits = [];
  state.filter = "";
  state.editingItem = null;
  state.selected.clear();
  state.anchor = null;
  state.activeTag = tag;
  await loadTags();
  render();
  void probeVisible();
}

/** Items of the list currently shown with full actions: a space or the dashboard's tag view. */
function listItems(): ItemView[] {
  if (state.globalQuery) return [];
  if (state.current) return state.current.items;
  if (state.activeTag) return state.tagHits.map((h) => h.item);
  return [];
}

let probeSeq = 0;
/** Checks existence/size/date of the visible items in the background. */
async function probeVisible() {
  const paths = [...new Set([...(state.current?.items ?? []), ...[...state.hits, ...state.tagHits].map((h) => h.item)].map((i) => i.path))];
  if (!paths.length) return;
  const seq = ++probeSeq;
  const res = await guard(api.probe(paths));
  if (!res || seq !== probeSeq) return;
  res.forEach((p) => state.probes.set(p.path, p));
  render();
}

async function loadHealth() {
  const res = await guard(api.spaceHealth());
  if (!res) return;
  state.health = new Map(res.map((h) => [h.spaceId, h]));
  render();
}

async function selectSpace(id: string) {
  state.current = (await guard(api.getSpace(id))) ?? null;
  state.settings = false;
  state.filter = "";
  state.editingItem = null;
  state.selected.clear();
  state.anchor = null;
  state.globalQuery = "";
  state.hits = [];
  render();
  void probeVisible();
}

async function addToSpace(spaceId: string, paths: string[]) {
  if (!paths.length) return;
  const res = await guard(api.addPaths(spaceId, paths));
  if (!res) return;
  const name = state.spaces.find((s) => s.id === spaceId)?.name ?? "Space";
  const parts = [`${res.added} hinzugefügt zu „${name}“`];
  if (res.duplicates) parts.push(`${res.duplicates} bereits vorhanden`);
  if (res.missing.length) parts.push(`${res.missing.length} nicht gefunden`);
  if (res.offline.length) parts.push(`${res.offline.length} auf nicht erreichbarer Netzwerkfreigabe`);
  toast(parts.join(" · "), res.missing.length || res.offline.length ? "err" : "ok");
  if (state.current?.id !== spaceId) await selectSpace(spaceId);
  await refresh();
}

async function pickAndAdd(directory: boolean) {
  if (!state.current) return;
  const sel = await open({ multiple: true, directory, title: directory ? "Ordner verknüpfen" : "Dateien verknüpfen" });
  if (!sel) return;
  await addToSpace(state.current.id, Array.isArray(sel) ? sel : [sel]);
}

async function copyFiles(paths: string[]) {
  if (!paths.length) return;
  const res = await guard(api.copyFiles(paths));
  if (!res) return;
  const what = res.copied === 1 ? "1 Element" : `${res.copied} Elemente`;
  toast(
    `${what} in die Zwischenablage kopiert. Mit Strg+V einfügen.` +
      (res.missing ? ` ${res.missing} nicht gefunden, übersprungen.` : "") +
      (res.offline ? ` ${res.offline} offline (Netzwerk), übersprungen.` : ""),
    res.missing || res.offline ? "err" : "ok",
  );
}

async function copyPaths(paths: string[]) {
  if (!paths.length) return;
  if ((await guard(api.copyPaths(paths))) === undefined) return;
  toast(paths.length === 1 ? "Pfad kopiert." : `${paths.length} Pfade kopiert.`);
}

/** Paths of the selection, in the order shown. */
function selectedPaths(): string[] {
  return sortedItems(listItems())
    .filter((i) => state.selected.has(i.id))
    .map((i) => i.path);
}

function selectRow(id: string, ev: MouseEvent) {
  const visible = sortedItems(listItems()).map((i) => i.id);
  if (ev.shiftKey && state.anchor && visible.includes(state.anchor)) {
    const [a, b] = [visible.indexOf(state.anchor), visible.indexOf(id)].sort((x, y) => x - y);
    if (!ev.ctrlKey) state.selected.clear();
    visible.slice(a, b + 1).forEach((x) => state.selected.add(x));
  } else if (ev.ctrlKey || ev.metaKey) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    state.anchor = id;
  } else {
    state.selected = new Set([id]);
    state.anchor = id;
  }
  render();
}

// ---------- rendering ----------

function sortedItems(items: ItemView[]): ItemView[] {
  const f = state.filter.trim().toLowerCase();
  const list = f
    ? items.filter((i) => `${i.label ?? ""} ${i.name} ${i.path} ${i.note} ${i.tags.join(" ")}`.toLowerCase().includes(f))
    : [...items];
  const name = (i: ItemView) => (i.label ?? i.name).toLowerCase();
  const cmp: Record<SortKey, (a: ItemView, b: ItemView) => number> = {
    added: (a, b) => b.addedAt - a.addedAt,
    name: (a, b) => name(a).localeCompare(name(b), "de"),
    location: (a, b) => a.location.localeCompare(b.location, "de") || name(a).localeCompare(name(b), "de"),
    modified: (a, b) => (state.probes.get(b.path)?.modified ?? 0) - (state.probes.get(a.path)?.modified ?? 0),
  };
  // Folders first, then the chosen order.
  return list.sort((a, b) => (a.kind === b.kind ? cmp[state.sort](a, b) : a.kind === "folder" ? -1 : 1));
}

function healthBadges(h: SpaceHealth | undefined): string {
  if (!h) return "";
  return (
    (h.offline ? `<span class="offline-badge" title="${h.offline} auf nicht erreichbarer Netzwerkfreigabe">${svg("offline")}</span>` : "") +
    (h.missing ? `<span class="warn" title="${h.missing} Verknüpfung(en) nicht gefunden">!</span>` : "")
  );
}

function sortedSpaces(): SpaceSummary[] {
  const list = [...state.spaces];
  switch (state.spaceSort) {
    case "name":
      return list.sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));
    case "newest":
      return list.sort((a, b) => b.createdAt - a.createdAt);
    case "oldest":
      return list.sort((a, b) => a.createdAt - b.createdAt);
  }
}

function colorPopover(id: string, current: string): string {
  const custom = COLORS.includes(current.toLowerCase()) ? "" : current;
  return `
    <div class="color-popover" role="dialog" aria-label="Farbe wählen" data-space="${id}">
      <div class="swatches">
        ${COLORS.map(
          (c) => `<button class="swatch ${c === current.toLowerCase() ? "active" : ""}" data-action="set-color" data-color="${c}"
                          style="background:${c}" title="${c}"></button>`,
        ).join("")}
      </div>
      <label class="custom-color">
        <input type="color" id="custom-color" value="${esc(/^#[0-9a-f]{6}$/i.test(current) ? current : "#4f7cff")}" />
        <span>Eigene Farbe${custom ? ` <code>${esc(custom)}</code>` : ""}</span>
      </label>
    </div>`;
}

function renderSidebar(): string {
  const items = sortedSpaces()
    .map((s) =>
      state.renaming === s.id
        ? `<li>
             <form id="rename-form" class="rename-form" data-id="${s.id}">
               <span class="dot" style="background:${esc(s.color)}"></span>
               <input id="rename-input" value="${esc(s.name)}" maxlength="80" autocomplete="off" aria-label="Neuer Name" />
             </form>
           </li>`
        : `<li class="${state.colorPicker === s.id && state.colorPickerAt === "sidebar" ? "picking" : ""}">
             <button class="space-link ${state.current?.id === s.id && !state.settings ? "active" : ""} ${state.dropTarget === s.id ? "drop" : ""}"
                     data-action="select" data-id="${s.id}" data-drop-space="${s.id}" title="Doppelklick zum Umbenennen">
               <span class="dot pick" data-action="pick-color" data-id="${s.id}" data-at="sidebar" title="Farbe ändern"
                     style="background:${esc(s.color)}"></span>
               <span class="space-name">${esc(s.name)}</span>
               ${healthBadges(state.health.get(s.id))}
               <span class="count">${s.itemCount}</span>
             </button>
             ${state.colorPicker === s.id && state.colorPickerAt === "sidebar" ? colorPopover(s.id, s.color) : ""}
           </li>`,
    )
    .join("");
  return `
    <aside class="sidebar">
      <div class="brand">
        <img src="/app-icon.svg" alt="" width="22" height="22" />
        <span>OneSpace</span>
        <button class="icon-btn theme-toggle" data-action="toggle-theme"
                title="${isDark() ? "Helles Design" : "Dunkles Design"}">${svg(isDark() ? "sun" : "moon")}</button>
      </div>
      <input class="search" id="global-search" type="search" placeholder="In allen Spaces suchen…" value="${esc(state.globalQuery)}" />
      <button class="space-link nav ${!state.current && !state.globalQuery && !state.settings ? "active" : ""}" data-action="dashboard">
        ${svg("grid")}
        <span class="space-name">Dashboard</span>
        ${state.tags.length ? `<span class="count" title="Tags">${state.tags.length}</span>` : ""}
      </button>
      <div class="section-label">
        <span>Spaces</span>
        ${
          state.spaces.length > 1
            ? `<select id="space-sort" class="mini-select" aria-label="Spaces sortieren" title="Spaces sortieren">
                 ${(
                   [
                     ["oldest", "Alt zuerst"],
                     ["newest", "Neu zuerst"],
                     ["name", "Name A–Z"],
                   ] as const
                 )
                   .map(([k, l]) => `<option value="${k}" ${state.spaceSort === k ? "selected" : ""}>${l}</option>`)
                   .join("")}
               </select>`
            : ""
        }
      </div>
      <ul class="space-list">${items}</ul>
      ${
        state.creating
          ? `<form id="create-form" class="create-form">
               <input id="create-name" placeholder="Name des Space" maxlength="80" autocomplete="off" />
             </form>`
          : `<button class="new-space" data-action="new-space">+ Neuer Space</button>`
      }
      <div class="sidebar-footer">
        <button class="space-link nav ${state.settings ? "active" : ""}" data-action="settings">
          ${svg("gear")}
          <span class="space-name">Settings</span>
          ${state.storage?.warning ? `<span class="warn" title="Speicherort prüfen">!</span>` : ""}
        </button>
      </div>
    </aside>`;
}

function tagChips(tags: string[]): string {
  if (!tags.length) return "";
  return `<div class="item-tags">${tags
    .map(
      (t) => `<button class="tag ${state.activeTag?.toLowerCase() === t.toLowerCase() && !state.current ? "active" : ""}"
                      data-action="goto-tag" data-tag="${esc(t)}" title="Alle Elemente mit diesem Tag">#${esc(t)}</button>`,
    )
    .join("")}</div>`;
}

const parseTags = (s: string) => s.split(/[,;]/).map((t) => t.trim()).filter(Boolean);

function tagEditor(i: ItemView): string {
  const own = new Set(i.tags.map((t) => t.toLowerCase()));
  const suggestions = state.tags.filter((t) => !own.has(t.name.toLowerCase())).slice(0, 12);
  return `
    <input name="tags" placeholder="Tags, durch Komma getrennt (z. B. Rechnung, Kunde A)" value="${esc(i.tags.join(", "))}" autocomplete="off" />
    ${
      suggestions.length
        ? `<div class="tag-suggestions">${suggestions
            .map((t) => `<button type="button" class="tag" data-action="suggest-tag" data-tag="${esc(t.name)}">+ ${esc(t.name)}</button>`)
            .join("")}</div>`
        : ""
    }`;
}

/**
 * One row with all actions. `spaceId` is the space the item belongs to; `hit` adds a chip
 * linking to that space (used outside a space, e.g. in the dashboard's tag view).
 */
function renderItem(i: ItemView, spaceId: string, hit?: SearchHit): string {
  const editing = state.editingItem === i.id;
  const title = i.label ?? i.name;
  const st = statusOf(i);
  return `
    <li class="item selectable ${hit ? "with-space" : ""} ${st} ${state.selected.has(i.id) ? "selected" : ""}"
        data-id="${i.id}" data-path="${esc(i.path)}" data-space="${spaceId}">
      ${iconFor(i)}
      <div class="item-body">
        ${
          editing
            ? `<form class="edit-form" data-id="${i.id}">
                 <input name="label" placeholder="${esc(i.name)}" value="${esc(i.label ?? "")}" />
                 <textarea name="note" rows="2" placeholder="Notiz zur Rolle im Projekt…">${esc(i.note)}</textarea>
                 ${tagEditor(i)}
                 <div class="row">
                   <button type="submit" class="btn primary small">Speichern</button>
                   <button type="button" class="btn small" data-action="cancel-edit">Abbrechen</button>
                 </div>
               </form>`
            : `<div class="item-title" title="${esc(i.path)}">${esc(title)}${i.label ? ` <span class="orig">${esc(i.name)}</span>` : ""}</div>
               <div class="item-path">
                 ${locChip(i)}
                 <span class="parent" title="${esc(i.parent)}"><bdi dir="ltr">${esc(i.parent)}</bdi></span>
               </div>
               ${i.note ? `<div class="item-note">${esc(i.note)}</div>` : ""}
               ${tagChips(i.tags)}`
        }
      </div>
      ${hit ? spaceChip(hit) : ""}
      <div class="item-meta">
        ${metaFor(i)}
      </div>
      <div class="item-actions">
        ${
          st !== "missing"
            ? `<button class="icon-btn" data-action="open" title="Öffnen">${svg("open")}</button>
               <button class="icon-btn" data-action="copy" title="In Zwischenablage kopieren (Strg+C)">${svg("copy")}</button>
               <button class="icon-btn" data-action="reveal" title="Im Explorer zeigen">${svg("reveal")}</button>`
            : `<button class="btn small" data-action="relink" title="Neuen Speicherort wählen">Neu verknüpfen</button>`
        }
        <button class="icon-btn" data-action="copy-path" title="Pfad kopieren (Strg+Umschalt+C)">${svg("path")}</button>
        <button class="icon-btn" data-action="edit" title="Bezeichnung, Notiz &amp; Tags">${svg("edit")}</button>
        <button class="icon-btn danger" data-action="remove" title="Aus Space entfernen (Original bleibt)">${svg("remove")}</button>
      </div>
    </li>`;
}

function spaceChip(h: SearchHit): string {
  return `<button class="space-chip" data-action="goto-space" data-id="${h.spaceId}" title="Space öffnen">
            <span class="dot" style="background:${esc(h.spaceColor)}"></span>${esc(h.spaceName)}
          </button>`;
}

function locChip(i: ItemView): string {
  return `<span class="loc ${i.network ? "net" : ""}" title="${esc(i.location)}">${i.network ? svg("network") : ""}<span class="loc-text">${esc(i.location)}</span></span>`;
}

function metaFor(i: ItemView): string {
  const p = state.probes.get(i.path);
  switch (p?.status) {
    case undefined:
      return `<span class="pending" title="Wird geprüft…">…</span>`;
    case "missing":
      return `<button class="missing-badge" data-action="locate"
                title="${i.network ? "Speicherort im Explorer öffnen. Verbindet das Netzlaufwerk, falls getrennt." : "Speicherort im Explorer öffnen"}">${svg("reveal")}Nicht gefunden</button>`;
    case "offline":
      return `<span class="offline-text" title="Die Netzwerkfreigabe antwortet nicht. Die Datei ist vermutlich noch da.">${svg("offline")} Offline</span>`;
    case "ok":
      return esc(
        [i.kind === "file" ? fmtSize(p.size) : "Ordner", p.modified ? `geändert ${fmtDate(p.modified)}` : ""]
          .filter(Boolean)
          .join(" · "),
      );
  }
}

type IconName =
  | "open" | "reveal" | "edit" | "remove" | "trash" | "copy" | "path" | "network" | "offline" | "grid" | "tag"
  | "sun" | "moon" | "gear" | "folder";

function svg(name: IconName): string {
  const paths = {
    open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    reveal: "M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM10 13h6M13 10l3 3-3 3",
    edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
    remove: "M6 6l12 12M18 6L6 18",
    copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
    path: "M4 6h16M4 12h10M4 18h7M15 15l3 3 3-3M18 11v7",
    network: "M12 3v6M5 21h14M12 15v6M4 9h16v6H4z",
    offline: "M3 3l18 18M8.5 8.5A5 5 0 0 0 7 18h10M17.7 13.1A4 4 0 0 0 12.6 8M10 5.3A6 6 0 0 1 18 10",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
    grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    tag: "M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9zM7.5 7.5h.01",
    sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
    moon: "M20 14.5A8 8 0 1 1 9.5 4 6.5 6.5 0 0 0 20 14.5z",
    gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4l-.4 2.5a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.4 2.5h4l.4-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4z",
    folder: "M3 6.5A1.5 1.5 0 0 1 4.5 5h4.6l2 2h8.4A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z",
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
}

/** Selection bar, filter and sort; shared by the space view and the dashboard's tag view. */
function listControls(filterPlaceholder: string): string {
  return `${
    state.selected.size
      ? `<div class="selection-bar">
           <span><strong>${state.selected.size}</strong> ausgewählt</span>
           <button class="btn small primary" data-action="copy-selected" title="Strg+C">Kopieren</button>
           <button class="btn small" data-action="copy-paths-selected" title="Strg+Umschalt+C">Pfade kopieren</button>
           <button class="btn small" data-action="select-all" title="Strg+A">Alle auswählen</button>
           <button class="btn small" data-action="clear-selection" title="Esc">Auswahl aufheben</button>
         </div>`
      : ""
  }
   <div class="toolbar">
     <input type="search" id="filter" class="search" placeholder="${esc(filterPlaceholder)}" value="${esc(state.filter)}" />
     <select id="sort" aria-label="Sortierung">
       ${(
         [
           ["added", "Zuletzt hinzugefügt"],
           ["name", "Name"],
           ["location", "Speicherort"],
           ["modified", "Zuletzt geändert"],
         ] as const
       )
         .map(([k, l]) => `<option value="${k}" ${state.sort === k ? "selected" : ""}>${l}</option>`)
         .join("")}
     </select>
   </div>`;
}

function renderSpace(s: SpaceView): string {
  const items = sortedItems(s.items);
  const missing = s.items.filter((i) => statusOf(i) === "missing").length;
  const offline = s.items.filter((i) => statusOf(i) === "offline").length;
  const locations = [...new Set(s.items.map((i) => i.location))];
  return `
    <header class="space-header">
      <div class="color-anchor">
        <button class="color-dot" data-action="pick-color" data-id="${s.id}" data-at="header" title="Farbe ändern" style="background:${esc(s.color)}"></button>
        ${state.colorPicker === s.id && state.colorPickerAt === "header" ? colorPopover(s.id, s.color) : ""}
      </div>
      <input class="space-title" id="space-title" value="${esc(s.name)}" maxlength="80" aria-label="Name des Space" />
      <div class="header-actions">
        <button class="btn" data-action="add-files">Dateien verknüpfen</button>
        <button class="btn" data-action="add-folder">Ordner verknüpfen</button>
        <button class="icon-btn danger" data-action="delete-space" title="Space löschen">${svg("trash")}</button>
      </div>
    </header>
    <div class="stats">
      <span>${s.items.length} Verknüpfung${s.items.length === 1 ? "" : "en"}</span>
      ${locations.length ? `<span>aus ${locations.map(esc).join(", ")}</span>` : ""}
      ${missing ? `<span class="warn-text">${missing} nicht gefunden</span>` : ""}
      ${offline ? `<span class="offline-text">${offline} offline (Netzwerkfreigabe nicht erreichbar)</span>` : ""}
    </div>
    ${
      s.items.length
        ? `${listControls("In diesem Space filtern…")}
           <ul class="items">${items.map((i) => renderItem(i, s.id)).join("") || `<li class="no-match">Keine Treffer.</li>`}</ul>`
        : `<div class="dropzone-empty">
             <div class="big">Dateien und Ordner hierher ziehen</div>
             <p>Aus Dokumente, Downloads, OneDrive, Desktop oder einem anderen Projektordner.
                OneSpace merkt sich nur den Pfad. Die Originale bleiben, wo sie sind.</p>
             <div class="row">
               <button class="btn primary" data-action="add-files">Dateien wählen</button>
               <button class="btn" data-action="add-folder">Ordner wählen</button>
             </div>
           </div>`
    }`;
}

function renderSearch(): string {
  const rows = state.hits
    .map(
      (h) => `
      <li class="item hit ${statusOf(h.item)}" data-id="${h.item.id}" data-path="${esc(h.item.path)}" data-space="${h.spaceId}">
        ${iconFor(h.item)}
        <div class="item-body">
          <div class="item-title">${esc(h.item.label ?? h.item.name)}</div>
          <div class="item-path">${locChip(h.item)}<span class="parent" title="${esc(h.item.parent)}"><bdi dir="ltr">${esc(h.item.parent)}</bdi></span></div>
          ${tagChips(h.item.tags)}
        </div>
        ${spaceChip(h)}
        <div class="item-actions">
          ${statusOf(h.item) !== "missing" ? `<button class="icon-btn" data-action="open" title="Öffnen">${svg("open")}</button>
          <button class="icon-btn" data-action="copy" title="In Zwischenablage kopieren">${svg("copy")}</button>
          <button class="icon-btn" data-action="reveal" title="Im Explorer zeigen">${svg("reveal")}</button>` : ""}
          <button class="icon-btn" data-action="copy-path" title="Pfad kopieren">${svg("path")}</button>
        </div>
      </li>`,
    )
    .join("");
  return `
    <header class="space-header"><h1 class="space-title static">Suche: „${esc(state.globalQuery)}“</h1></header>
    <div class="stats"><span>${state.hits.length} Treffer in allen Spaces</span></div>
    <ul class="items">${rows || `<li class="no-match">Nichts gefunden.</li>`}</ul>`;
}

function renderDashboard(): string {
  const total = state.spaces.reduce((n, s) => n + s.itemCount, 0);
  const active = state.activeTag?.toLowerCase();
  const pills = state.tags
    .map(
      (t) => `<button class="tag-pill ${t.name.toLowerCase() === active ? "active" : ""}" data-action="toggle-tag" data-tag="${esc(t.name)}">
                ${svg("tag")}<span>${esc(t.name)}</span><span class="count">${t.count}</span>
              </button>`,
    )
    .join("");
  const byId = new Map(state.tagHits.map((h) => [h.item.id, h]));
  const items = sortedItems(state.tagHits.map((h) => h.item));
  return `
    <header class="space-header"><h1 class="space-title static">Dashboard</h1></header>
    <div class="stats">
      <span>${state.tags.length} Tag${state.tags.length === 1 ? "" : "s"}</span>
      <span>${state.spaces.length} Space${state.spaces.length === 1 ? "" : "s"}</span>
      <span>${total} Verknüpfung${total === 1 ? "" : "en"}</span>
    </div>
    ${
      state.tags.length
        ? `<div class="tag-cloud">${pills}</div>`
        : `<div class="dropzone-empty">
             <div class="big">Noch keine Tags vergeben</div>
             <p>Öffne einen Space und klicke bei einem Element auf das Stift-Symbol.
                Dort kannst du Tags eintragen, zum Beispiel „Rechnung“ oder „Vertrag“.
                Hier siehst du dann alle Elemente mit diesem Tag, über alle Spaces hinweg.</p>
           </div>`
    }
    ${
      state.activeTag
        ? `<h2 class="tag-heading">${svg("tag")} ${esc(state.activeTag)}
             <span class="count">${state.tagHits.length} Element${state.tagHits.length === 1 ? "" : "e"}</span>
           </h2>
           ${listControls(`In „${state.activeTag}“ filtern…`)}
           <ul class="items">${
             items.map((i) => renderItem(i, byId.get(i.id)!.spaceId, byId.get(i.id))).join("") ||
             `<li class="no-match">Keine Treffer.</li>`
           }</ul>`
        : state.tags.length
          ? `<p class="hint">Wähle ein Tag, um alle Elemente damit zu sehen.</p>`
          : ""
    }`;
}

function renderSettings(): string {
  const info = state.storage;
  const themes = [
    ["system", "Wie Windows"],
    ["light", "Hell"],
    ["dark", "Dunkel"],
  ] as const;
  return `
    <header class="space-header"><h1 class="space-title static">Settings</h1></header>
    <section class="settings-card">
      <h2>Darstellung</h2>
      <div class="segmented" role="radiogroup" aria-label="Design">
        ${themes
          .map(
            ([k, l]) => `<button role="radio" aria-checked="${state.theme === k}" class="${state.theme === k ? "active" : ""}"
                                 data-action="set-theme" data-theme="${k}">${l}</button>`,
          )
          .join("")}
      </div>
    </section>
    <section class="settings-card">
      <h2>Speicherort der Daten</h2>
      <p class="hint">In dieser Datei stehen alle Spaces, Verknüpfungen, Notizen und Tags, nicht die Dateien selbst.
         Lege sie zum Beispiel in einen OneDrive- oder Netzwerkordner, um sie zu sichern.</p>
      ${info?.warning ? `<div class="notice warn-box">${esc(info.warning)}</div>` : ""}
      ${
        info
          ? `<div class="path-box">
               ${svg("folder")}
               <code title="${esc(info.path)}">${esc(info.path)}</code>
               ${info.isDefault ? `<span class="badge">Standard</span>` : ""}
             </div>
             <div class="row">
               <button class="btn primary" data-action="choose-location">Anderen Ordner wählen…</button>
               <button class="btn" data-action="reveal-data">Im Explorer zeigen</button>
               ${info.isDefault ? "" : `<button class="btn" data-action="reset-location">Standard wiederherstellen</button>`}
             </div>
             <p class="hint small">Beim Wechsel bleibt die bisherige Datei unverändert liegen. Liegt am Ziel schon eine
                OneSpace-Datei, kannst du sie übernehmen oder (mit Sicherung als <code>spaces.json.bak</code>) überschreiben.</p>`
          : `<p class="hint">Wird geladen…</p>`
      }
    </section>`;
}

function renderMain(): string {
  if (state.settings) return renderSettings();
  if (state.globalQuery) return renderSearch();
  if (state.current) return renderSpace(state.current);
  if (state.spaces.length) return renderDashboard();
  return `
    <div class="welcome">
      <h1>Ein Space für jedes Projekt</h1>
      <p>Führe Dateien, Ordner und Ressourcen von überall auf deinem PC zusammen, ohne die Originale zu verschieben oder zu kopieren.</p>
      <ol>
        <li>Lege links einen Space an.</li>
        <li>Ziehe Dateien und Ordner aus dem Explorer hinein.</li>
        <li>Öffne sie später direkt aus dem Space. Die Originale bleiben in Dokumente, Downloads oder OneDrive.</li>
      </ol>
      <button class="btn primary" data-action="new-space">+ Ersten Space anlegen</button>
    </div>`;
}

function render() {
  const focusedId = document.activeElement?.id;
  const selStart = (document.activeElement as HTMLInputElement | null)?.selectionStart ?? null;
  app.innerHTML = `
    ${renderSidebar()}
    <main class="main">${renderMain()}</main>
    <div class="drop-overlay ${state.dragging ? "show" : ""}">
      <div class="drop-card">
        ${
          state.dropTarget || state.current
            ? `Loslassen, um zu „${esc(
                state.spaces.find((s) => s.id === (state.dropTarget ?? state.current?.id))?.name ?? "",
              )}“ hinzuzufügen<small>Nur der Pfad wird gespeichert. Nichts wird verschoben.</small>`
            : `Zuerst einen Space wählen oder auf einen Space links ziehen`
        }
      </div>
    </div>`;
  if (focusedId) {
    const el = document.getElementById(focusedId) as HTMLInputElement | null;
    if (el) {
      el.focus();
      if (selStart != null && "setSelectionRange" in el) el.setSelectionRange(selStart, selStart);
    }
  }
  if (state.creating) document.getElementById("create-name")?.focus();
  const rename = document.getElementById("rename-input") as HTMLInputElement | null;
  if (rename && document.activeElement !== rename) {
    rename.focus();
    rename.select();
  }
}

// ---------- actions: spaces, theme, storage ----------

async function setSpaceColor(id: string, color: string) {
  await guard(api.updateSpace(id, { color }));
  await refresh();
}

async function renameSpace(id: string, name: string) {
  state.renaming = null;
  const old = state.spaces.find((s) => s.id === id);
  if (!name.trim() || name.trim() === old?.name) return render();
  await guard(api.updateSpace(id, { name }));
  await refresh();
}

function setTheme(theme: Theme) {
  state.theme = theme;
  savePref("theme", theme);
  applyTheme(theme);
  render();
}

async function loadStorage() {
  state.storage = (await guard(api.storageInfo())) ?? null;
}

/** Switches the data file to `dir` (null = default), asking what to do with a file already there. */
async function changeLocation(dir: string | null) {
  const check = await guard(api.inspectLocation(dir));
  if (!check) return;
  if (state.storage && check.path.toLowerCase() === state.storage.path.toLowerCase()) {
    return toast("Die Daten liegen bereits dort.");
  }
  let useExisting = false;
  if (check.exists && check.error) {
    const ok = await ask(
      `Am Ziel liegt bereits eine Datei, die sich nicht lesen lässt:\n${check.error}\n\nMit deinen aktuellen Daten überschreiben? Die alte Datei wird als spaces.json.bak gesichert.`,
      { title: "Speicherort ändern", kind: "warning", okLabel: "Überschreiben", cancelLabel: "Abbrechen" },
    );
    if (!ok) return;
  } else if (check.exists) {
    const n = check.spaces ?? 0;
    useExisting = await ask(
      `In diesem Ordner liegt bereits eine OneSpace-Datei mit ${n} Space${n === 1 ? "" : "s"}.\n\nSoll OneSpace diese Datei verwenden? Deine bisherigen Daten bleiben in der alten Datei erhalten.`,
      { title: "Speicherort ändern", kind: "info", okLabel: "Vorhandene verwenden", cancelLabel: "Nicht verwenden" },
    );
    if (!useExisting) {
      const ok = await ask(
        `Die vorhandene Datei mit deinen aktuellen ${state.spaces.length} Spaces überschreiben? Sie wird vorher als spaces.json.bak gesichert.`,
        { title: "Speicherort ändern", kind: "warning", okLabel: "Überschreiben", cancelLabel: "Abbrechen" },
      );
      if (!ok) return;
    }
  }
  const info = await guard(api.changeLocation(dir, useExisting));
  if (!info) return;
  state.storage = info;
  if (useExisting) {
    state.current = null;
    state.activeTag = null;
    state.selected.clear();
  }
  toast(useExisting ? "Vorhandene Datei wird jetzt verwendet." : "Daten am neuen Ort gespeichert.");
  await refresh();
}

// ---------- events ----------

let lastSelect = { id: "", at: 0 };

app.addEventListener("click", async (ev) => {
  const target = ev.target as HTMLElement;
  if (state.colorPicker && !target.closest(".color-popover, [data-action='pick-color']")) {
    state.colorPicker = null;
    render();
    if (!target.closest("[data-action]")) return;
  }
  const btn = target.closest<HTMLElement>("[data-action]");
  if (!btn) {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".item.selectable");
    if (row && !(ev.target as HTMLElement).closest("input, textarea, form")) selectRow(row.dataset.id!, ev);
    return;
  }
  const action = btn.dataset.action!;
  const row = btn.closest<HTMLElement>(".item");
  const s = state.current;
  /** Space of the clicked row; differs from `state.current` in the dashboard. */
  const rowSpace = row?.dataset.space;

  switch (action) {
    case "select": {
      // Second click on the same space within a short time: rename inline.
      const id = btn.dataset.id!;
      const now = Date.now();
      const again = lastSelect.id === id && now - lastSelect.at < 450;
      lastSelect = { id, at: again ? 0 : now };
      if (again) {
        state.renaming = id;
        return render();
      }
      return state.current?.id === id && !state.settings ? undefined : selectSpace(id);
    }
    case "pick-color": {
      ev.stopPropagation();
      const id = btn.dataset.id!;
      const at = (btn.dataset.at ?? "sidebar") as "sidebar" | "header";
      const same = state.colorPicker === id && state.colorPickerAt === at;
      state.colorPicker = same ? null : id;
      state.colorPickerAt = at;
      return render();
    }
    case "set-color": {
      const id = btn.closest<HTMLElement>(".color-popover")!.dataset.space!;
      state.colorPicker = null;
      return setSpaceColor(id, btn.dataset.color!);
    }
    case "toggle-theme":
      return setTheme(isDark() ? "light" : "dark");
    case "set-theme":
      return setTheme(btn.dataset.theme as Theme);
    case "settings":
      state.settings = true;
      state.globalQuery = "";
      state.hits = [];
      state.selected.clear();
      state.editingItem = null;
      render();
      return loadStorage().then(render);
    case "choose-location": {
      const dir = await open({ directory: true, multiple: false, title: "Ordner für die OneSpace-Daten wählen" });
      if (typeof dir !== "string") return;
      return changeLocation(dir);
    }
    case "reset-location":
      return changeLocation(null);
    case "reveal-data":
      if (state.storage) await guard(api.revealPath(state.storage.path));
      return;
    case "dashboard":
      return showDashboard();
    case "toggle-tag": {
      const t = btn.dataset.tag!;
      return showDashboard(state.activeTag?.toLowerCase() === t.toLowerCase() ? null : t);
    }
    case "goto-tag":
      return showDashboard(btn.dataset.tag!);
    case "suggest-tag": {
      const input = btn.closest("form")?.querySelector<HTMLInputElement>('input[name="tags"]');
      if (!input) return;
      const tags = parseTags(input.value);
      if (!tags.some((t) => t.toLowerCase() === btn.dataset.tag!.toLowerCase())) tags.push(btn.dataset.tag!);
      input.value = tags.join(", ");
      btn.remove();
      return input.focus();
    }
    case "goto-space":
      return selectSpace(btn.dataset.id!);
    case "new-space":
      state.creating = true;
      return render();
    case "add-files":
      return pickAndAdd(false);
    case "add-folder":
      return pickAndAdd(true);
    case "delete-space": {
      if (!s) return;
      const ok = await ask(
        `Space „${s.name}“ löschen?\n\nNur der Space und seine Verknüpfungen werden entfernt. Deine Dateien bleiben unverändert.`,
        { title: "Space löschen", kind: "warning", okLabel: "Löschen", cancelLabel: "Abbrechen" },
      );
      if (!ok) return;
      await guard(api.deleteSpace(s.id));
      state.current = null;
      return refresh();
    }
    case "open":
      return void guard(api.openPath(row!.dataset.path!));
    case "copy":
      return copyFiles([row!.dataset.path!]);
    case "copy-path":
      return copyPaths([row!.dataset.path!]);
    case "copy-selected":
      return copyFiles(selectedPaths());
    case "copy-paths-selected":
      return copyPaths(selectedPaths());
    case "select-all":
      listItems().forEach((i) => state.selected.add(i.id));
      return render();
    case "clear-selection":
      state.selected.clear();
      return render();
    case "reveal":
      return void guard(api.revealPath(row!.dataset.path!));
    case "locate":
      return void guard(api.openLocation(row!.dataset.path!));
    case "edit":
      state.editingItem = row!.dataset.id!;
      render();
      return void document.querySelector<HTMLInputElement>(`.edit-form[data-id="${row!.dataset.id}"] input`)?.focus();
    case "cancel-edit":
      state.editingItem = null;
      return render();
    case "remove":
      if (!rowSpace) return;
      await guard(api.removeItem(rowSpace, row!.dataset.id!));
      state.selected.delete(row!.dataset.id!);
      toast("Aus dem Space entfernt. Das Original ist unverändert.");
      return refresh();
    case "relink": {
      if (!rowSpace) return;
      const item = listItems().find((i) => i.id === row!.dataset.id);
      const sel = await open({ multiple: false, directory: item?.kind === "folder", title: "Neuen Speicherort wählen" });
      if (typeof sel !== "string") return;
      await guard(api.relinkItem(rowSpace, row!.dataset.id!, sel));
      return refresh();
    }
  }
});

app.addEventListener("dblclick", (ev) => {
  const row = (ev.target as HTMLElement).closest<HTMLElement>(".item");
  if (!row || (ev.target as HTMLElement).closest("button, input, textarea, form")) return;
  if (!row.classList.contains("missing")) void guard(api.openPath(row.dataset.path!));
});

app.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target as HTMLFormElement;
  if (form.id === "rename-form") {
    await renameSpace(form.dataset.id!, (document.getElementById("rename-input") as HTMLInputElement).value);
  } else if (form.id === "create-form") {
    const name = (document.getElementById("create-name") as HTMLInputElement).value;
    state.creating = false;
    if (!name.trim()) return render();
    const created = await guard(api.createSpace(name));
    await refresh();
    if (created) await selectSpace(created.id);
  } else if (form.classList.contains("edit-form")) {
    const spaceId = form.closest<HTMLElement>(".item")?.dataset.space;
    if (!spaceId) return;
    const fd = new FormData(form);
    await guard(
      api.updateItem(spaceId, form.dataset.id!, {
        label: String(fd.get("label") ?? ""),
        note: String(fd.get("note") ?? ""),
        tags: parseTags(String(fd.get("tags") ?? "")),
      }),
    );
    state.editingItem = null;
    await refresh();
  }
});

let searchTimer: number | undefined;
app.addEventListener("input", (ev) => {
  const t = ev.target as HTMLInputElement;
  if (t.id === "filter") {
    state.filter = t.value;
    render();
  } else if (t.id === "global-search") {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(async () => {
      state.globalQuery = t.value.trim();
      state.hits = state.globalQuery ? ((await guard(api.search(state.globalQuery))) ?? []) : [];
      render();
    }, 150);
  }
});

app.addEventListener("change", async (ev) => {
  const t = ev.target as HTMLInputElement;
  const s = state.current;
  if (t.id === "sort") {
    state.sort = t.value as SortKey;
    render();
  } else if (t.id === "space-sort") {
    state.spaceSort = t.value as SpaceSort;
    savePref("spaceSort", state.spaceSort);
    render();
  } else if (t.id === "custom-color") {
    const id = t.closest<HTMLElement>(".color-popover")?.dataset.space;
    state.colorPicker = null;
    if (id) await setSpaceColor(id, t.value);
  } else if (t.id === "space-title" && s && t.value.trim() && t.value !== s.name) {
    await guard(api.updateSpace(s.id, { name: t.value }));
    await refresh();
  }
});

// Global shortcuts for the selection; ignored while typing in a field.
document.addEventListener("keydown", (ev) => {
  const t = ev.target as HTMLElement;
  const items = listItems();
  if (t.closest("input, textarea, select") || !items.length) return;
  const ctrl = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();
  if (ctrl && key === "c" && state.selected.size) {
    ev.preventDefault();
    void (ev.shiftKey ? copyPaths(selectedPaths()) : copyFiles(selectedPaths()));
  } else if (ctrl && key === "a") {
    ev.preventDefault();
    items.forEach((i) => state.selected.add(i.id));
    render();
  } else if (ev.key === "Escape" && state.selected.size && !state.creating && !state.editingItem && !state.colorPicker) {
    state.selected.clear();
    render();
  }
});

app.addEventListener("keydown", (ev) => {
  const t = ev.target as HTMLElement;
  if (ev.key === "Escape") {
    if (state.colorPicker) {
      state.colorPicker = null;
      render();
    } else if (state.renaming) {
      state.renaming = null;
      render();
    } else if (state.creating) {
      state.creating = false;
      render();
    } else if (state.editingItem) {
      state.editingItem = null;
      render();
    }
  } else if (ev.key === "Enter" && t.id === "space-title") {
    (t as HTMLInputElement).blur();
  }
});

app.addEventListener("focusout", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.id === "rename-input" && state.renaming) {
    void renameSpace(state.renaming, (t as HTMLInputElement).value);
    return;
  }
  if (t.id === "create-name" && state.creating) {
    // Submit on blur if something was typed, otherwise cancel.
    const v = (t as HTMLInputElement).value;
    if (v.trim()) (document.getElementById("create-form") as HTMLFormElement).requestSubmit();
    else {
      state.creating = false;
      setTimeout(render);
    }
  }
});

// Native drag & drop from Explorer. Dropping onto a space in the sidebar adds it there.
function spaceAt(pos: { x: number; y: number }): string | null {
  const r = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(pos.x / r, pos.y / r)?.closest<HTMLElement>("[data-drop-space]");
  return el?.dataset.dropSpace ?? null;
}

void getCurrentWebview().onDragDropEvent(async (ev) => {
  const p = ev.payload;
  if (p.type === "enter" || p.type === "over") {
    const target = spaceAt(p.position);
    if (!state.dragging || target !== state.dropTarget) {
      state.dragging = true;
      state.dropTarget = target;
      render();
    }
  } else if (p.type === "drop") {
    const target = spaceAt(p.position) ?? state.current?.id ?? null;
    state.dragging = false;
    state.dropTarget = null;
    render();
    if (!target) return toast("Bitte zuerst einen Space wählen oder anlegen.", "err");
    await addToSpace(target, p.paths);
  } else {
    state.dragging = false;
    state.dropTarget = null;
    render();
  }
});

// Re-check file existence when the window regains focus (files may have moved meanwhile).
window.addEventListener("focus", () => void refresh());

applyTheme(state.theme);
darkQuery.addEventListener("change", () => state.theme === "system" && render());

// Start on the dashboard. A data file that could not be loaded is reported once.
void loadStorage().then(() => {
  if (state.storage?.warning) toast(state.storage.warning, "err", 9000);
  return refresh();
});
