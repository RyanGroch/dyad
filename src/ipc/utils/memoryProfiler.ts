// TEMP: Memory profiler for diagnosing OOM during chat streaming.
// Remove this file (and its imports in the stream handlers) once the
// investigation is complete.
//
// Outputs:
//   - Periodic `process.memoryUsage()` lines in the main-process log
//     (electron-log). Look for scope "memoryProfiler".
//   - V8 heap snapshots written to:
//       <userData>/heap-snapshots/<timestamp>-<label>.heapsnapshot
//     Load these into Chrome DevTools -> Memory -> "Load profile..."
//     to inspect retained size per object.
//
// Snapshots are taken automatically at:
//   - stream start
//   - stream end
//   - the first time RSS crosses each threshold in RSS_SNAPSHOT_THRESHOLDS_MB
//     (so you get progressively larger snapshots as memory grows)

import { app } from "electron";
import log from "electron-log";
import * as v8 from "node:v8";
import * as path from "node:path";
import * as fs from "node:fs";

const logger = log.scope("memoryProfiler");

// Take a snapshot the first time RSS crosses each of these (MB).
const RSS_SNAPSHOT_THRESHOLDS_MB = [750, 1500, 2500, 3500, 5000];

const crossedThresholds = new Set<number>();

function fmt(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function logMemory(
  label: string,
  extra?: Record<string, unknown>,
): void {
  const m = process.memoryUsage();
  const parts = [
    `rss=${fmt(m.rss)}`,
    `heapUsed=${fmt(m.heapUsed)}`,
    `heapTotal=${fmt(m.heapTotal)}`,
    `external=${fmt(m.external)}`,
    `arrayBuffers=${fmt(m.arrayBuffers)}`,
  ];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      parts.push(`${k}=${v}`);
    }
  }
  logger.info(`[${label}] ${parts.join(" ")}`);
}

export function writeHeapSnapshot(label: string): string | null {
  try {
    const dir = path.join(app.getPath("userData"), "heap-snapshots");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = path.join(dir, `${ts}-${safeLabel}.heapsnapshot`);
    const before = process.memoryUsage();
    logger.warn(`Writing heap snapshot (rss=${fmt(before.rss)}): ${filename}`);
    v8.writeHeapSnapshot(filename);
    logger.warn(`Heap snapshot written: ${filename}`);
    return filename;
  } catch (err) {
    logger.error("Failed to write heap snapshot", err);
    return null;
  }
}

export interface MemoryMonitorHandle {
  stop: () => void;
  tick: (extra?: Record<string, unknown>) => void;
}

export function startMemoryMonitor(
  label: string,
  options: {
    intervalMs?: number;
    snapshotOnStart?: boolean;
    snapshotOnEnd?: boolean;
    getExtra?: () => Record<string, unknown> | undefined;
  } = {},
): MemoryMonitorHandle {
  const intervalMs = options.intervalMs ?? 5000;
  const snapshotOnStart = options.snapshotOnStart ?? true;
  const snapshotOnEnd = options.snapshotOnEnd ?? true;

  logMemory(`${label}:start`, options.getExtra?.());
  if (snapshotOnStart) {
    writeHeapSnapshot(`${label}-start`);
  }

  const checkThresholds = () => {
    const rssMB = process.memoryUsage().rss / 1024 / 1024;
    for (const threshold of RSS_SNAPSHOT_THRESHOLDS_MB) {
      if (rssMB >= threshold && !crossedThresholds.has(threshold)) {
        crossedThresholds.add(threshold);
        logger.warn(
          `RSS crossed ${threshold}MB (currently ${rssMB.toFixed(1)}MB); snapshotting`,
        );
        writeHeapSnapshot(`${label}-rss${threshold}MB`);
      }
    }
  };

  const interval = setInterval(() => {
    logMemory(`${label}:tick`, options.getExtra?.());
    checkThresholds();
  }, intervalMs);

  return {
    stop: () => {
      clearInterval(interval);
      logMemory(`${label}:end`, options.getExtra?.());
      if (snapshotOnEnd) {
        writeHeapSnapshot(`${label}-end`);
      }
    },
    tick: (extra) => {
      logMemory(`${label}:manual`, { ...options.getExtra?.(), ...extra });
      checkThresholds();
    },
  };
}

/**
 * Approximate size of a value by JSON-serializing it. Expensive — only
 * call from non-hot paths (e.g. once per retry, not per chunk).
 */
export function approxJsonSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return -1;
  }
}
