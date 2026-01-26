import { dialog } from "electron";
import {
  existsSync,
  mkdirSync,
  statSync,
  lstatSync,
  symlinkSync,
  readlinkSync,
} from "fs";
import { join, isAbsolute, dirname } from "path";
import { homedir } from "os";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { desc } from "drizzle-orm";
import { createTypedHandler } from "./base";
import { systemContracts } from "../types/system";
import { getDyadAppsBaseDirectory } from "@/paths/paths";
import { writeSettings } from "@/main/settings";

export function registerDyadAppsDirectoryHandlers() {
  createTypedHandler(systemContracts.getDyadAppsBaseDirectory, async () => {
    const dyadAppsDir = getDyadAppsBaseDirectory();

    return {
      path: dyadAppsDir,
      isCustomPath: dyadAppsDir !== join(homedir(), "dyad-apps"),
    };
  });

  createTypedHandler(systemContracts.selectDyadAppsBaseDirectory, async () => {
    const result = await dialog.showOpenDialog({
      title: "Select Dyad Apps Folder",
      properties: ["openDirectory"],
      message: "Select the folder where Dyad apps should be stored",
    });

    if (result.canceled) {
      return { path: null, canceled: true };
    }

    if (!result.filePaths[0] || !statSync(result.filePaths[0])) {
      return { path: null, canceled: false };
    }

    return { path: result.filePaths[0], canceled: false };
  });

  createTypedHandler(
    systemContracts.setDyadAppsBaseDirectory,
    async (_, input) => {
      const newDyadAppsDir = !input
        ? join(homedir(), "dyad-apps")
        : statSync(input).isDirectory()
          ? input
          : (() => {
              throw new Error("Path is not a directory");
            })();

      // If we're resetting to the default dyad-apps directory,
      // we need to make sure that it exists
      mkdirSync(newDyadAppsDir, { recursive: true });

      const allApps = await db.query.apps.findMany({
        orderBy: [desc(apps.createdAt)],
      });

      // We don't want to make current apps inaccessible after changing the directory.
      // So, we add symlinks in the new directory to each of the user's apps.
      allApps.forEach((app) => {
        if (!isAbsolute(app.path)) {
          const link = join(newDyadAppsDir, app.path);
          const seenPaths = new Set();
          let target = join(getDyadAppsBaseDirectory(), app.path);

          // We don't want chains of symlinks,
          // so we always link to the original directory
          while (
            existsSync(target) &&
            lstatSync(target).isSymbolicLink() &&
            !seenPaths.has(target) // avoid infinite loop
          ) {
            seenPaths.add(target);
            const nextTarget = readlinkSync(target);
            target = isAbsolute(nextTarget)
              ? nextTarget
              : join(dirname(target), nextTarget);
          }

          if (existsSync(target) && !existsSync(link)) {
            symlinkSync(target, link);
          }
        }
      });

      writeSettings({ customDyadAppsBaseDirectory: input });
    },
  );
}
