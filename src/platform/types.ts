export type DesktopPlatform = "windows" | "macos";

export interface PlatformProfile {
  platform: DesktopPlatform;
  ptyBackend: "ConPTY" | "Unix PTY";
  localShells: string[];
}
