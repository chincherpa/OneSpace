import { invoke } from "@tauri-apps/api/core";

export type Kind = "file" | "folder";

export interface SpaceSummary {
  id: string;
  name: string;
  color: string;
  itemCount: number;
}

export interface ItemView {
  id: string;
  path: string;
  kind: Kind;
  name: string;
  label: string | null;
  note: string;
  addedAt: number;
  extension: string;
  location: string;
  network: boolean;
  parent: string;
}

export interface SpaceView {
  id: string;
  name: string;
  description: string;
  color: string;
  createdAt: number;
  items: ItemView[];
}

export interface AddResult {
  added: number;
  duplicates: number;
  missing: string[];
  offline: string[];
}

export type Status = "ok" | "missing" | "offline";

export interface Probe {
  path: string;
  status: Status;
  isDir: boolean;
  size: number | null;
  modified: number | null;
}

export interface SpaceHealth {
  spaceId: string;
  missing: number;
  offline: number;
}

export interface SearchHit {
  spaceId: string;
  spaceName: string;
  spaceColor: string;
  item: ItemView;
}

export interface CopyResult {
  copied: number;
  missing: number;
  offline: number;
}

export const api = {
  listSpaces: () => invoke<SpaceSummary[]>("list_spaces"),
  getSpace: (id: string) => invoke<SpaceView>("get_space", { id }),
  createSpace: (name: string) => invoke<SpaceSummary>("create_space", { name }),
  updateSpace: (id: string, patch: { name?: string; description?: string; color?: string }) =>
    invoke<void>("update_space", { id, ...patch }),
  deleteSpace: (id: string) => invoke<void>("delete_space", { id }),
  addPaths: (spaceId: string, paths: string[]) => invoke<AddResult>("add_paths", { spaceId, paths }),
  removeItem: (spaceId: string, itemId: string) => invoke<void>("remove_item", { spaceId, itemId }),
  updateItem: (spaceId: string, itemId: string, patch: { label?: string; note?: string }) =>
    invoke<void>("update_item", { spaceId, itemId, ...patch }),
  relinkItem: (spaceId: string, itemId: string, newPath: string) =>
    invoke<void>("relink_item", { spaceId, itemId, newPath }),
  search: (query: string) => invoke<SearchHit[]>("search", { query }),
  probe: (paths: string[]) => invoke<Probe[]>("probe", { paths }),
  spaceHealth: () => invoke<SpaceHealth[]>("space_health"),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  revealPath: (path: string) => invoke<void>("reveal_path", { path }),
  copyFiles: (paths: string[]) => invoke<CopyResult>("copy_files", { paths }),
  copyPaths: (paths: string[]) => invoke<void>("copy_paths", { paths }),
};
