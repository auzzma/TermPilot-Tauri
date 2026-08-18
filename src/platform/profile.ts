import { invoke } from "@tauri-apps/api/core";

import type { PlatformProfile } from "./types";

export function loadPlatformProfile(): Promise<PlatformProfile> {
  return invoke<PlatformProfile>("platform_profile");
}
