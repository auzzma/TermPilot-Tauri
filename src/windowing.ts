import { invoke } from "@tauri-apps/api/core";

import {
  cloneWorkspaceSnapshot,
  useAppStore,
} from "./store";

export async function openClonedWindow() {
  const key = crypto.randomUUID();
  const storageKey = `termpilot:window-clone:${key}`;
  const clone = cloneWorkspaceSnapshot(useAppStore.getState().workspace);
  localStorage.setItem(storageKey, JSON.stringify(clone));

  try {
    await invoke("open_cloned_window", { key });
  } catch {
    localStorage.removeItem(storageKey);
  }
}
