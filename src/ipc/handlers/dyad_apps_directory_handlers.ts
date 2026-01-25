import { dialog } from "electron";
import { existsSync, statSync, symlinkSync } from "fs";
import { join, isAbsolute } from "path";
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
      const newDyadAppsDir =
        input && statSync(input).isDirectory()
          ? input
          : join(homedir(), "dyad-apps");

      const allApps = await db.query.apps.findMany({
        orderBy: [desc(apps.createdAt)],
      });

      // We don't want to make current apps inaccessible after changing the directory.
      // So, we add symlinks in the new directory to each of the user's apps.
      allApps.forEach((app) => {
        if (!isAbsolute(app.path)) {
          const link = join(newDyadAppsDir, app.path);
          const target = join(getDyadAppsBaseDirectory(), app.path);
          if (existsSync(target) && !existsSync(link)) {
            symlinkSync(target, link);
          }
        }
      });

      writeSettings({ customDyadAppsBaseDirectory: input });
    },
  );
}
