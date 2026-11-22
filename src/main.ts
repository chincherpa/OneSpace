import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { api, type ItemView, type SearchHit, type SpaceSummary, type SpaceView } from "./api";

const COLORS = ["#4f7cff", "#16a37f", "#e2683c", "#a35bd6", "#d4a017", "#d6457a", "#2e9bc4", "#6b7a8f"];

type SortKey = "added" | "name" | "location" | "modified";

const state = {
  spaces: [] as SpaceSummary[],
  current: null as SpaceView | null,
  filter: "",
  sort: "added" as SortKey,
  globalQuery: "",
  hits: [] as SearchHit[],
  editingItem: null as string | null,
  creating: false,
  dragging: false,
  dropTarget: null as string | null,
  selected: new Set<string>(),
  anchor: null as string | null,
};

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
function toast(msg: string, kind: "ok" | "err" = "ok") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.className = `toast show ${kind}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), 3200);
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
  render();
}

async function selectSpace(id: string) {
  state.current = (await guard(api.getSpace(id))) ?? null;
  state.filter = "";
  state.editingItem = null;
  state.selected.clear();
  state.anchor = null;
  state.globalQuery = "";
  state.hits = [];
  try {
    localStorage.setItem("onespace.lastSpace", id);
  } catch {
    /* storage unavailable */
  }
  render();
}

async function addToSpace(spaceId: string, paths: string[]) {
  if (!paths.length) return;
  const res = await guard(api.addPaths(spaceId, paths));
  if (!res) return;
  const name = state.spaces.find((s) => s.id === spaceId)?.name ?? "Space";
  const parts = [`${res.added} hinzugefügt zu „${name}“`];
  if (res.duplicates) parts.push(`${res.duplicates} bereits vorhanden`);
  if (res.missing.length) parts.push(`${res.missing.length} nicht gefunden`);
  toast(parts.join(" · "), res.missing.length ? "err" : "ok");
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
      (res.missing ? ` (${res.missing} nicht gefunden, übersprungen)` : ""),
    res.missing ? "err" : "ok",
  );
}

async function copyPaths(paths: string[]) {
  if (!paths.length) return;
  if ((await guard(api.copyPaths(paths))) === undefined) return;
  toast(paths.length === 1 ? "Pfad kopiert." : `${paths.length} Pfade kopiert.`);
}

/** Paths of the selection, in the order shown. */
function selectedPaths(): string[] {
  if (!state.current) return [];
  return sortedItems(state.current.items)
    .filter((i) => state.selected.has(i.id))
    .map((i) => i.path);
}

function selectRow(id: string, ev: MouseEvent) {
  const visible = state.current ? sortedItems(state.current.items).map((i) => i.id) : [];
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
    ? items.filter((i) => `${i.label ?? ""} ${i.name} ${i.path} ${i.note}`.toLowerCase().includes(f))
    : [...items];
  const name = (i: ItemView) => (i.label ?? i.name).toLowerCase();
  const cmp: Record<SortKey, (a: ItemView, b: ItemView) => number> = {
    added: (a, b) => b.addedAt - a.addedAt,
    name: (a, b) => name(a).localeCompare(name(b), "de"),
    location: (a, b) => a.location.localeCompare(b.location, "de") || name(a).localeCompare(name(b), "de"),
    modified: (a, b) => (b.modified ?? 0) - (a.modified ?? 0),
  };
  // Folders first, then the chosen order.
  return list.sort((a, b) => (a.kind === b.kind ? cmp[state.sort](a, b) : a.kind === "folder" ? -1 : 1));
}

function renderSidebar(): string {
  const items = state.spaces
    .map(
      (s) => `
      <li>
        <button class="space-link ${state.current?.id === s.id ? "active" : ""} ${state.dropTarget === s.id ? "drop" : ""}"
                data-action="select" data-id="${s.id}" data-drop-space="${s.id}">
          <span class="dot" style="background:${esc(s.color)}"></span>
          <span class="space-name">${esc(s.name)}</span>
          ${s.missingCount ? `<span class="warn" title="${s.missingCount} Verknüpfung(en) nicht gefunden">!</span>` : ""}
          <span class="count">${s.itemCount}</span>
        </button>
      </li>`,
    )
    .join("");
  return `
    <aside class="sidebar">
      <div class="brand">
        <img src="/app-icon.svg" alt="" width="22" height="22" />
        <span>OneSpace</span>
      </div>
      <input class="search" id="global-search" type="search" placeholder="In allen Spaces suchen…" value="${esc(state.globalQuery)}" />
      <div class="section-label">Spaces</div>
      <ul class="space-list">${items}</ul>
      ${
        state.creating
          ? `<form id="create-form" class="create-form">
               <input id="create-name" placeholder="Name des Space" maxlength="80" autocomplete="off" />
             </form>`
          : `<button class="new-space" data-action="new-space">+ Neuer Space</button>`
      }
      <p class="tagline">Speichert die Karte, nicht die Dateien.</p>
    </aside>`;
}

function renderItem(i: ItemView): string {
  const editing = state.editingItem === i.id;
  const title = i.label ?? i.name;
  const meta = [
    i.kind === "file" ? fmtSize(i.size) : "Ordner",
    i.modified ? `geändert ${fmtDate(i.modified)}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `
    <li class="item selectable ${i.exists ? "" : "missing"} ${state.selected.has(i.id) ? "selected" : ""}" data-id="${i.id}" data-path="${esc(i.path)}">
      ${iconFor(i)}
      <div class="item-body">
        ${
          editing
            ? `<form class="edit-form" data-id="${i.id}">
                 <input name="label" placeholder="${esc(i.name)}" value="${esc(i.label ?? "")}" />
                 <textarea name="note" rows="2" placeholder="Notiz zur Rolle im Projekt…">${esc(i.note)}</textarea>
                 <div class="row">
                   <button type="submit" class="btn primary small">Speichern</button>
                   <button type="button" class="btn small" data-action="cancel-edit">Abbrechen</button>
                 </div>
               </form>`
            : `<div class="item-title" title="${esc(i.path)}">${esc(title)}${i.label ? ` <span class="orig">${esc(i.name)}</span>` : ""}</div>
               <div class="item-path">
                 <span class="loc">${esc(i.location)}</span>
                 <span class="parent" title="${esc(i.parent)}">${esc(i.parent)}</span>
               </div>
               ${i.note ? `<div class="item-note">${esc(i.note)}</div>` : ""}`
        }
      </div>
      <div class="item-meta">
        ${i.exists ? esc(meta) : `<span class="missing-badge">Nicht gefunden</span>`}
      </div>
      <div class="item-actions">
        ${
          i.exists
            ? `<button class="icon-btn" data-action="open" title="Öffnen">${svg("open")}</button>
               <button class="icon-btn" data-action="copy" title="In Zwischenablage kopieren (Strg+C)">${svg("copy")}</button>
               <button class="icon-btn" data-action="reveal" title="Im Explorer zeigen">${svg("reveal")}</button>`
            : `<button class="btn small" data-action="relink" title="Neuen Speicherort wählen">Neu verknüpfen</button>`
        }
        <button class="icon-btn" data-action="edit" title="Bezeichnung &amp; Notiz">${svg("edit")}</button>
        <button class="icon-btn danger" data-action="remove" title="Aus Space entfernen (Original bleibt)">${svg("remove")}</button>
      </div>
    </li>`;
}

function svg(name: "open" | "reveal" | "edit" | "remove" | "trash" | "copy"): string {
  const paths = {
    open: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
    reveal: "M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1zM10 13h6M13 10l3 3-3 3",
    edit: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
    remove: "M6 6l12 12M18 6L6 18",
    copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
    trash: "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6",
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
}

function renderSpace(s: SpaceView): string {
  const items = sortedItems(s.items);
  const missing = s.items.filter((i) => !i.exists).length;
  const locations = [...new Set(s.items.map((i) => i.location))];
  return `
    <header class="space-header">
      <button class="color-dot" data-action="cycle-color" title="Farbe ändern" style="background:${esc(s.color)}"></button>
      <input class="space-title" id="space-title" value="${esc(s.name)}" maxlength="80" aria-label="Name des Space" />
      <div class="header-actions">
        <button class="btn" data-action="add-files">Dateien verknüpfen</button>
        <button class="btn" data-action="add-folder">Ordner verknüpfen</button>
        <button class="icon-btn danger" data-action="delete-space" title="Space löschen">${svg("trash")}</button>
      </div>
    </header>
    <textarea class="space-desc" id="space-desc" rows="1" placeholder="Worum geht es in diesem Projekt?">${esc(s.description)}</textarea>
    <div class="stats">
      <span>${s.items.length} Verknüpfung${s.items.length === 1 ? "" : "en"}</span>
      ${locations.length ? `<span>aus ${locations.map(esc).join(", ")}</span>` : ""}
      ${missing ? `<span class="warn-text">${missing} nicht gefunden</span>` : ""}
    </div>
    ${
      s.items.length
        ? `${
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
             <input type="search" id="filter" class="search" placeholder="In diesem Space filtern…" value="${esc(state.filter)}" />
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
           </div>
           <ul class="items">${items.map(renderItem).join("") || `<li class="no-match">Keine Treffer.</li>`}</ul>`
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
      <li class="item hit ${h.item.exists ? "" : "missing"}" data-id="${h.item.id}" data-path="${esc(h.item.path)}" data-space="${h.spaceId}">
        ${iconFor(h.item)}
        <div class="item-body">
          <div class="item-title">${esc(h.item.label ?? h.item.name)}</div>
          <div class="item-path"><span class="loc">${esc(h.item.location)}</span><span class="parent">${esc(h.item.parent)}</span></div>
        </div>
        <button class="space-chip" data-action="goto-space" data-id="${h.spaceId}">
          <span class="dot" style="background:${esc(h.spaceColor)}"></span>${esc(h.spaceName)}
        </button>
        <div class="item-actions">
          ${h.item.exists ? `<button class="icon-btn" data-action="open" title="Öffnen">${svg("open")}</button>
          <button class="icon-btn" data-action="copy" title="In Zwischenablage kopieren">${svg("copy")}</button>
          <button class="icon-btn" data-action="reveal" title="Im Explorer zeigen">${svg("reveal")}</button>` : ""}
        </div>
      </li>`,
    )
    .join("");
  return `
    <header class="space-header"><h1 class="space-title static">Suche: „${esc(state.globalQuery)}“</h1></header>
    <div class="stats"><span>${state.hits.length} Treffer in allen Spaces</span></div>
    <ul class="items">${rows || `<li class="no-match">Nichts gefunden.</li>`}</ul>`;
}

function renderMain(): string {
  if (state.globalQuery) return renderSearch();
  if (state.current) return renderSpace(state.current);
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
  const desc = document.getElementById("space-desc") as HTMLTextAreaElement | null;
  if (desc) autosize(desc);
  if (state.creating) document.getElementById("create-name")?.focus();
}

function autosize(t: HTMLTextAreaElement) {
  t.style.height = "auto";
  t.style.height = `${t.scrollHeight}px`;
}

// ---------- events ----------

app.addEventListener("click", async (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!btn) {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".item.selectable");
    if (row && !(ev.target as HTMLElement).closest("input, textarea, form")) selectRow(row.dataset.id!, ev);
    return;
  }
  const action = btn.dataset.action!;
  const row = btn.closest<HTMLElement>(".item");
  const s = state.current;

  switch (action) {
    case "select":
      return selectSpace(btn.dataset.id!);
    case "goto-space":
      return selectSpace(btn.dataset.id!);
    case "new-space":
      state.creating = true;
      return render();
    case "add-files":
      return pickAndAdd(false);
    case "add-folder":
      return pickAndAdd(true);
    case "cycle-color": {
      if (!s) return;
      const next = COLORS[(COLORS.indexOf(s.color) + 1) % COLORS.length];
      await guard(api.updateSpace(s.id, { color: next }));
      return refresh();
    }
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
    case "copy-selected":
      return copyFiles(selectedPaths());
    case "copy-paths-selected":
      return copyPaths(selectedPaths());
    case "select-all":
      s?.items.forEach((i) => state.selected.add(i.id));
      return render();
    case "clear-selection":
      state.selected.clear();
      return render();
    case "reveal":
      return void guard(api.revealPath(row!.dataset.path!));
    case "edit":
      state.editingItem = row!.dataset.id!;
      render();
      return void document.querySelector<HTMLInputElement>(`.edit-form[data-id="${row!.dataset.id}"] input`)?.focus();
    case "cancel-edit":
      state.editingItem = null;
      return render();
    case "remove":
      if (!s) return;
      await guard(api.removeItem(s.id, row!.dataset.id!));
      state.selected.delete(row!.dataset.id!);
      toast("Aus dem Space entfernt. Das Original ist unverändert.");
      return refresh();
    case "relink": {
      if (!s) return;
      const item = s.items.find((i) => i.id === row!.dataset.id);
      const sel = await open({ multiple: false, directory: item?.kind === "folder", title: "Neuen Speicherort wählen" });
      if (typeof sel !== "string") return;
      await guard(api.relinkItem(s.id, row!.dataset.id!, sel));
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
  if (form.id === "create-form") {
    const name = (document.getElementById("create-name") as HTMLInputElement).value;
    state.creating = false;
    if (!name.trim()) return render();
    const created = await guard(api.createSpace(name));
    await refresh();
    if (created) await selectSpace(created.id);
  } else if (form.classList.contains("edit-form") && state.current) {
    const fd = new FormData(form);
    await guard(
      api.updateItem(state.current.id, form.dataset.id!, {
        label: String(fd.get("label") ?? ""),
        note: String(fd.get("note") ?? ""),
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
  } else if (t.id === "space-desc") {
    autosize(t as unknown as HTMLTextAreaElement);
  }
});

app.addEventListener("change", async (ev) => {
  const t = ev.target as HTMLInputElement;
  const s = state.current;
  if (t.id === "sort") {
    state.sort = t.value as SortKey;
    render();
  } else if (t.id === "space-title" && s && t.value.trim() && t.value !== s.name) {
    await guard(api.updateSpace(s.id, { name: t.value }));
    await refresh();
  } else if (t.id === "space-desc" && s && t.value !== s.description) {
    await guard(api.updateSpace(s.id, { description: t.value }));
    s.description = t.value;
  }
});

// Global shortcuts for the selection; ignored while typing in a field.
document.addEventListener("keydown", (ev) => {
  const t = ev.target as HTMLElement;
  if (t.closest("input, textarea, select") || !state.current || state.globalQuery) return;
  const ctrl = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();
  if (ctrl && key === "c" && state.selected.size) {
    ev.preventDefault();
    void (ev.shiftKey ? copyPaths(selectedPaths()) : copyFiles(selectedPaths()));
  } else if (ctrl && key === "a") {
    ev.preventDefault();
    state.current.items.forEach((i) => state.selected.add(i.id));
    render();
  } else if (ev.key === "Escape" && state.selected.size && !state.creating && !state.editingItem) {
    state.selected.clear();
    render();
  }
});

app.addEventListener("keydown", (ev) => {
  const t = ev.target as HTMLElement;
  if (ev.key === "Escape") {
    if (state.creating) {
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

(async () => {
  await refresh();
  let last: string | null = null;
  try {
    last = localStorage.getItem("onespace.lastSpace");
  } catch {
    /* storage unavailable */
  }
  const id = state.spaces.find((s) => s.id === last)?.id ?? state.spaces[0]?.id;
  if (id) await selectSpace(id);
})();
