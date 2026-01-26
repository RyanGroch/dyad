import { dialog } from "electron";
import {
  existsSync,
  mkdirSync,
  statSync,
  lstatSync,
  symlinkSync,
  readlinkSync,
} from "fs";
import log from "electron-log";
import { join, isAbsolute, dirname } from "path";
import { homedir } from "os";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { desc } from "drizzle-orm";
import { createTypedHandler } from "./base";
import { systemContracts } from "../types/system";
import { getDyadAppsBaseDirectory } from "@/paths/paths";
import { writeSettings } from "@/main/settings";

const logger = log.scope("dyad_apps_base_directory_handlers");

export function registerDyadAppsBaseDirectoryHandlers() {
  createTypedHandler(systemContracts.getDyadAppsBaseDirectory, async () => {
    const dyadAppsBaseDir = getDyadAppsBaseDirectory();

    return {
      path: dyadAppsBaseDir,
      isCustomPath: dyadAppsBaseDir !== join(homedir(), "dyad-apps"),
    };
  });

  createTypedHandler(systemContracts.selectDyadAppsBaseDirectory, async () => {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: "Select Dyad Apps Folder",
      properties: ["openDirectory"],
      message: "Select the folder where Dyad apps should be stored",
    });

    if (canceled) {
      return { path: null, canceled: true };
    }

    if (!filePaths[0] || !existsSync(filePaths[0])) {
      return { path: null, canceled: false };
    }

    return { path: filePaths[0], canceled: false };
  });

  createTypedHandler(
    systemContracts.setDyadAppsBaseDirectory,
    async (_, input) => {
      const newDyadAppsBaseDir = !input
        ? join(homedir(), "dyad-apps")
        : statSync(input).isDirectory()
          ? input
          : (() => {
              throw new Error("Path is not a directory");
            })();

      // If we're resetting to the default dyad-apps directory,
      // we need to make sure that it exists
      mkdirSync(newDyadAppsBaseDir, { recursive: true });

      const allApps = await db.query.apps.findMany({
        orderBy: [desc(apps.createdAt)],
      });

      // We don't want to make current apps inaccessible after changing the directory.
      // So, we add symlinks in the new directory to each of the user's apps.
      for (const app of allApps) {
        if (!isAbsolute(app.path)) {
          const link = join(newDyadAppsBaseDir, app.path);
          const seenPaths = new Set();
          let target = join(getDyadAppsBaseDirectory(), app.path);

          // We don't want chains of symlinks,
          // so we always link to the original directory
          while (!seenPaths.has(target)) {
            let st;
            try {
              st = lstatSync(target);
            } catch {
              break;
            }

            if (!st.isSymbolicLink()) break;

            seenPaths.add(target);
            const nextTarget = readlinkSync(target);
            target = isAbsolute(nextTarget)
              ? nextTarget
              : join(dirname(target), nextTarget);
          }

          try {
            symlinkSync(target, link, "junction");
          } catch (err: any) {
            // If we already have access to the app (or one with the same name),
            // or the app no longer exists, then we can safely skip the symlink
            if (err.code === "EEXIST" || err.code === "ENOENT") {
              logger.debug(
                [
                  "Skipping symlink creation",
                  `FROM: ${link}`,
                  `TO: ${target}`,
                  `REASON: ${err.code}`,
                ].join("\n"),
              );
              continue;
            }

            // We stop the settings change if we're removing access to apps
            logger.error(
              [
                "Failed to create required symlink",
                `FROM: ${link}`,
                `TO: ${target}`,
                `ERROR: ${err.code ?? err.message}`,
              ].join("\n"),
            );
            throw err;
          }
        }
      }

      writeSettings({ customDyadAppsBaseDirectory: input });
    },
  );
}
