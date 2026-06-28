// THROWAWAY measurement instrumentation (measure/stream-hotpath branch).
// Writes newline-delimited JSON metrics to userData/stream-metrics.jsonl so a
// streaming repro can be diagnosed offline: which process hangs, where the
// main-thread CPU goes per chunk, per-process RSS/CPU, GPU crashes, and a
// renderer round-trip "responsiveness" ping that reflects IPC/render backpressure.
//
// Buffered + flushed on a timer so the logging itself does not add per-chunk
// synchronous file I/O to the very hot path we are measuring.
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";

let buffer: string[] = [];
let filePath: string | null = null;
let started = false;
const timers: NodeJS.Timeout[] = [];

export function metricEvent(obj: Record<string, unknown>): void {
  if (!started) return;
  buffer.push(JSON.stringify({ t: Date.now(), ...obj }));
}

function flush(): void {
  if (!filePath || buffer.length === 0) return;
  const data = buffer.join("\n") + "\n";
  buffer = [];
  try {
    fs.appendFileSync(filePath, data);
  } catch {
    // best effort
  }
}

// Time a synchronous call and return both its result and elapsed ms.
export function timeSync<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

export function startStreamMetrics(
  getWindow: () => BrowserWindow | null,
): void {
  if (started) return;
  started = true;
  filePath = path.join(app.getPath("userData"), "stream-metrics.jsonl");
  try {
    fs.writeFileSync(filePath, "");
  } catch {
    // best effort
  }
  metricEvent({ kind: "start", mainPid: process.pid });

  // Main event-loop lag: a 100ms interval; the amount it overshoots 100ms is
  // how long the main thread was blocked. The single clearest "is main hung"
  // signal.
  const EXPECT_MS = 100;
  let last = performance.now();
  timers.push(
    setInterval(() => {
      const now = performance.now();
      const lag = now - last - EXPECT_MS;
      last = now;
      if (lag > 5)
        metricEvent({ kind: "mainloop_lag", lagMs: Math.round(lag) });
    }, EXPECT_MS),
  );

  // Per-process RSS + CPU and a renderer responsiveness ping every 500ms.
  let pingInFlight = false;
  timers.push(
    setInterval(() => {
      try {
        const procs = app.getAppMetrics().map((m) => ({
          type: m.type,
          // workingSetSize is in KB.
          rssMB: Math.round((m.memory?.workingSetSize ?? 0) / 1024),
          cpu: Math.round((m.cpu?.percentCPUUsage ?? 0) * 10) / 10,
        }));
        metricEvent({ kind: "procs", procs });
      } catch {
        // best effort
      }

      // Round-trip a trivial eval through the renderer's JS thread. If the
      // renderer is busy rendering or its IPC queue is backed up, this resolves
      // late -> high rttMs. Distinguishes "main hung" from "renderer/IPC backed
      // up" when read alongside mainloop_lag + per-process CPU.
      const win = getWindow();
      if (win && !win.isDestroyed() && win.webContents && !pingInFlight) {
        pingInFlight = true;
        const sent = performance.now();
        win.webContents
          .executeJavaScript("1", true)
          .then(() => {
            metricEvent({
              kind: "renderer_rtt",
              rttMs: Math.round(performance.now() - sent),
            });
          })
          .catch(() => {})
          .finally(() => {
            pingInFlight = false;
          });
      }
    }, 500),
  );

  timers.push(setInterval(flush, 500));
}

export function stopStreamMetrics(): void {
  for (const t of timers) clearInterval(t);
  timers.length = 0;
  flush();
  started = false;
}
