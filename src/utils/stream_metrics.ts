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
import os from "node:os";
import inspector from "node:inspector";
import { PerformanceObserver } from "node:perf_hooks";
import { app, BrowserWindow } from "electron";

const MB = 1024 * 1024;

// perf_hooks GC entry detail.kind values.
const GC_KIND: Record<number, string> = {
  1: "minor", // scavenge
  2: "incremental",
  4: "major", // mark-sweep-compact
  8: "weakcb",
};

let gcObserver: PerformanceObserver | null = null;

// Main-process CPU profiler. The V8 sampler runs on its own thread, so it
// captures the main thread's stack even while the JS event loop is blocked.
// Profiles are rotated to disk every 10s (4 files) so the lead-up to a freeze
// survives a force-kill.
let profSession: inspector.Session | null = null;
let profTimer: NodeJS.Timeout | null = null;
let profSeq = 0;

function startProfiler(): void {
  try {
    profSession = new inspector.Session();
    profSession.connect();
    profSession.post("Profiler.enable", () => {
      profSession?.post(
        "Profiler.setSamplingInterval",
        { interval: 1000 }, // microseconds (1ms) — low overhead
        () => {
          profSession?.post("Profiler.start");
        },
      );
    });
    profTimer = setInterval(rotateProfile, 10_000);
  } catch {
    // best effort
  }
}

function rotateProfile(restart = true): void {
  const session = profSession;
  if (!session) return;
  session.post("Profiler.stop", (err, res) => {
    const profile = (res as { profile?: unknown } | undefined)?.profile;
    if (!err && profile && filePath) {
      const p = path.join(
        path.dirname(filePath),
        `cpuprofile-${profSeq % 4}.cpuprofile`,
      );
      profSeq++;
      try {
        fs.writeFileSync(p, JSON.stringify(profile));
      } catch {
        // best effort
      }
    }
    if (restart) session.post("Profiler.start");
  });
}

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

  // GC pause observer: logs each GC's duration + kind. If mainloop_lag spikes
  // line up with multi-hundred-ms "major" entries, the freeze is GC. Only log
  // GCs > 5ms to skip the noise of frequent tiny minor collections.
  try {
    gcObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 5) continue;
        const kind = (e as unknown as { detail?: { kind?: number } }).detail
          ?.kind;
        metricEvent({
          kind: "gc",
          gcMs: Math.round(e.duration * 100) / 100,
          gcKind: kind != null ? (GC_KIND[kind] ?? String(kind)) : "?",
        });
      }
    });
    gcObserver.observe({ entryTypes: ["gc"] });
  } catch {
    // best effort
  }

  startProfiler();

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

      // Main-process memory split (JS heap vs native/off-heap) + system memory.
      // `external`/`arrayBuffers` ballooning while `heapUsed` stays modest ==
      // a native buffer leak (undici/SDK), which V8's heap cap does NOT bound.
      try {
        const mu = process.memoryUsage();
        metricEvent({
          kind: "mem",
          rssMB: Math.round(mu.rss / MB),
          heapUsedMB: Math.round(mu.heapUsed / MB),
          externalMB: Math.round(mu.external / MB),
          arrayBuffersMB: Math.round(mu.arrayBuffers / MB),
          sysUsedMB: Math.round((os.totalmem() - os.freemem()) / MB),
          sysTotalMB: Math.round(os.totalmem() / MB),
        });
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
  gcObserver?.disconnect();
  gcObserver = null;
  if (profTimer) {
    clearInterval(profTimer);
    profTimer = null;
  }
  rotateProfile(false);
  profSession?.disconnect();
  profSession = null;
  flush();
  started = false;
}
