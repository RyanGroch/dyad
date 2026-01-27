import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { IS_TEST_BUILD } from "../ipc/utils/test_utils";
import { readSettings, writeSettings } from "../main/settings";

/**
 * Gets the base dyad-apps directory path (without a specific app subdirectory)
 */
export function getDyadAppsBaseDirectory(): string {
  if (IS_TEST_BUILD) {
    const electron = getElectron();
    return path.join(electron!.app.getPath("userData"), "dyad-apps");
  }

  const defaultDir = path.join(os.homedir(), "dyad-apps");

  // If the user has not set a custom base directory, use default
  const customDir = readSettings().customDyadAppsBaseDirectory;
  if (!customDir) {
    return defaultDir;
  }

  let st;
  try {
    st = fs.statSync(customDir);
  } catch {
    // Just setting up to check defaultDir's existence+type, so fall through
  }

  // If the user's chosen directory doesn't exist or is inaccessible, reset to default
  if (!st || !st.isDirectory()) {
    writeSettings({ customDyadAppsBaseDirectory: null });
    return defaultDir;
  }

  return customDir;
}

export function getDyadAppPath(appPath: string): string {
  // If appPath is already absolute, use it as-is
  if (path.isAbsolute(appPath)) {
    return appPath;
  }
  // Otherwise, use the default base path
  return path.join(getDyadAppsBaseDirectory(), appPath);
}

export function getTypeScriptCachePath(): string {
  const electron = getElectron();
  return path.join(electron!.app.getPath("sessionData"), "typescript-cache");
}

/**
 * Gets the user data path, handling both Electron and non-Electron environments
 * In Electron: returns the app's userData directory
 * In non-Electron: returns "./userData" in the current directory
 */

export function getUserDataPath(): string {
  const electron = getElectron();

  // When running in Electron and app is ready
  if (process.env.NODE_ENV !== "development" && electron) {
    return electron!.app.getPath("userData");
  }

  // For development or when the Electron app object isn't available
  return path.resolve("./userData");
}

/**
 * Get a reference to electron in a way that won't break in non-electron environments
 */
export function getElectron(): typeof import("electron") | undefined {
  let electron: typeof import("electron") | undefined;
  try {
    // Check if we're in an Electron environment
    if (process.versions.electron) {
      electron = require("electron");
    }
  } catch {
    // Not in Electron environment
  }
  return electron;
}
