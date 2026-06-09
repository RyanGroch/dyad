import { expect } from "@playwright/test";

import { test } from "./helpers/test_helper";

// Streaming stress test. Not part of the normal e2e suite: the filename ends in
// `.manual.ts` (not `.spec.ts`) so Playwright's default glob skips it and it
// never runs in CI. Run it by hand against a large synthetic response to check
// that Dyad survives a very long LLM stream without crashing the renderer or
// blowing up memory in either process.
//
// Run (the env var flips playwright.config to match `*.manual.ts` only):
//   STRESS_TEST=1 npx playwright test
//
// Tune the load with the marker in the prompt below:
//   [stress-files=N] [stress-lines=M]   (defaults: 100 files x 100 lines)
// The fake LLM server generates N <dyad-write> blocks of M lines and streams
// them over the wire exactly like a real provider. Dyad has no idea it isn't a
// real model. No production code is involved.

// Scale of the generated response. Defaults to 100 files x 100 lines; override
// from the command line, e.g.
//   STRESS_TEST=1 STRESS_FILES=300 STRESS_LINES=500 npx playwright test
const STRESS_FILES = Number(process.env.STRESS_FILES ?? 100);
const STRESS_LINES = Number(process.env.STRESS_LINES ?? 100);

// Heap ceiling for either process. Generous: this is a blow-up detector, not a
// tight budget. Raise if you intentionally push the file/line counts far up.
const HEAP_CEILING_MB = 4096;

test("survives a very long streamed response without crashing or OOMing", async ({
  po,
}) => {
  // Headroom for heavier scales: 300x500 streams ~6 MB and takes ~30 min.
  test.setTimeout(45 * 60_000);

  await po.setUp();

  let rendererCrashed = false;
  po.page.on("crash", () => {
    rendererCrashed = true;
  });

  const rendererSamplesMB: number[] = [];
  const mainRssSamplesMB: number[] = [];
  const mainHeapSamplesMB: number[] = [];
  let sampling = true;

  // Live sampler: logs a line every ~500 ms so the trajectory (climbing vs
  // plateauing vs sawtooth GC) is visible while the stream runs, not just the
  // peak at the end. Tracks renderer JS heap, main-process RSS + heapUsed, and
  // main-process CPU% (derived from cpuUsage deltas over wall time).
  const start = Date.now();
  let prevCpu = await po.electronApp
    .evaluate(() => process.cpuUsage())
    .catch(() => ({ user: 0, system: 0 }));
  let prevCpuT = Date.now();
  // System CPU% is derived from os.cpus() tick deltas, like the prod monitor.
  let prevSysIdle = 0;
  let prevSysTotal = 0;

  const sampleMemory = async () => {
    while (sampling) {
      const rendererBytes = await po.page
        .evaluate(() => (performance as any).memory?.usedJSHeapSize ?? 0)
        .catch(() => 0);
      const main = await po.electronApp
        .evaluate(async () => {
          // Match Next.js's memory report: RSS + heapTotal from
          // process.memoryUsage(), heapUsed + heapMax from v8 heap statistics.
          // In the bundled main, module-scoped require/import aren't reachable
          // from evaluate, so try the global require paths and bail gracefully.
          const m = process.memoryUsage();
          let heapUsed = m.heapUsed;
          let heapMax = 0;
          let v8err = "";
          const req = (name: string): any => {
            const g: any = globalThis as any;
            if (typeof g.require === "function") return g.require(name);
            if (g.process?.mainModule?.require)
              return g.process.mainModule.require(name);
            const ev = (0, eval)(
              "typeof require!=='undefined'?require:null",
            ) as any;
            if (ev) return ev(name);
            return null;
          };
          try {
            const v8 = req("node:v8");
            if (v8) {
              const h = v8.getHeapStatistics();
              heapUsed = h.used_heap_size;
              heapMax = h.heap_size_limit;
            } else {
              v8err = "no require/import path available";
            }
          } catch (e: any) {
            v8err = String(e?.message ?? e);
          }

          // System memory + aggregate CPU ticks, mirroring the prod monitor.
          let sysTotal = 0;
          let sysFree = 0;
          let sysIdle = 0;
          let sysTick = 0;
          try {
            const os = req("node:os");
            if (os) {
              sysTotal = os.totalmem();
              sysFree = os.freemem();
              for (const c of os.cpus()) {
                for (const t in c.times) sysTick += (c.times as any)[t];
                sysIdle += c.times.idle;
              }
            }
          } catch {
            // os unavailable; system stats stay 0.
          }

          return {
            rss: m.rss,
            heapUsed,
            heapTotal: m.heapTotal,
            heapMax,
            cpu: process.cpuUsage(),
            sysTotal,
            sysFree,
            sysIdle,
            sysTick,
            v8err,
          };
        })
        .catch(() => null);

      const rendererMB = rendererBytes / 1024 / 1024;
      if (rendererBytes) rendererSamplesMB.push(rendererMB);

      if (main) {
        const MB = (b: number) => (b / 1024 / 1024).toFixed(2);
        const rssMB = main.rss / 1024 / 1024;
        const heapMB = main.heapUsed / 1024 / 1024;
        mainRssSamplesMB.push(rssMB);
        mainHeapSamplesMB.push(heapMB);

        const now = Date.now();
        const cpuMicros =
          main.cpu.user - prevCpu.user + (main.cpu.system - prevCpu.system);
        const cpuPct = (cpuMicros / ((now - prevCpuT) * 1000)) * 100;
        prevCpu = main.cpu;
        prevCpuT = now;

        // System memory used/total and system CPU% (tick deltas vs prev sample).
        const sysUsedMB = (main.sysTotal - main.sysFree) / 1024 / 1024;
        const sysTotalMB = main.sysTotal / 1024 / 1024;
        const sysMemPct = main.sysTotal
          ? (100 * (main.sysTotal - main.sysFree)) / main.sysTotal
          : 0;
        const tickDiff = main.sysTick - prevSysTotal;
        const sysCpuPct =
          prevSysTotal && tickDiff > 0
            ? 100 - (100 * (main.sysIdle - prevSysIdle)) / tickDiff
            : null;
        prevSysIdle = main.sysIdle;
        prevSysTotal = main.sysTick;

        const elapsed = ((now - start) / 1000).toFixed(1);
        if (main.v8err)
          console.log(`[stress] v8 heap stats unavailable: ${main.v8err}`);

        // Same fields as the prod logs (Next.js heap report + Dyad's perf
        // monitor), condensed to one line.
        const pct =
          main.heapMax > 0
            ? ` (${((100 * main.heapUsed) / main.heapMax).toFixed(1)}%)`
            : "";
        console.log(
          `[stress t=${elapsed}s] RSS ${MB(main.rss)}MB | ` +
            `Heap Used ${MB(main.heapUsed)}MB | ` +
            `Heap Total ${MB(main.heapTotal)}MB | ` +
            `Heap Max ${MB(main.heapMax)}MB${pct} | ` +
            `cpu ${cpuPct.toFixed(0)}% | renderer ${rendererMB.toFixed(0)}MB | ` +
            `sys mem ${sysUsedMB.toFixed(0)}/${sysTotalMB.toFixed(0)}MB (${sysMemPct.toFixed(1)}%) | ` +
            `sys cpu ${sysCpuPct === null ? "—" : sysCpuPct.toFixed(0) + "%"}`,
        );
      }

      await po.page.waitForTimeout(500).catch(() => {});
    }
  };
  const samplingDone = sampleMemory();

  await po.sendPrompt(
    `tc-stress [stress-files=${STRESS_FILES}] [stress-lines=${STRESS_LINES}]`,
    { skipWaitForCompletion: true },
  );

  // Wait for the stream to fully complete (retry button appears).
  await po.chatActions.waitForChatCompletion({ timeout: 44 * 60_000 });

  sampling = false;
  await samplingDone;

  const peak = (arr: number[]) =>
    arr.length ? Math.max(...arr).toFixed(0) : "n/a";
  console.log(
    `[stress] renderer heap peak: ${peak(rendererSamplesMB)} MB, ` +
      `main rss peak: ${peak(mainRssSamplesMB)} MB, ` +
      `main heap peak: ${peak(mainHeapSamplesMB)} MB, ` +
      `samples: ${rendererSamplesMB.length}`,
  );

  // 1) Renderer process did not die.
  expect(rendererCrashed).toBe(false);

  // 2) Neither process blew past the ceiling.
  for (const mb of rendererSamplesMB) expect(mb).toBeLessThan(HEAP_CEILING_MB);
  for (const mb of mainRssSamplesMB) expect(mb).toBeLessThan(HEAP_CEILING_MB);

  // 3) The parser finished: the last generated file block is rendered.
  const messagesList = po.page.getByTestId("messages-list");
  await expect(
    messagesList.getByText(
      `StressFile${String(STRESS_FILES).padStart(3, "0")}.tsx`,
      {
        exact: true,
      },
    ),
  ).toBeVisible({ timeout: 30_000 });

  // 4) Apply the proposal: writes all the generated files to disk. This both
  // exercises the file-write/apply path under load and unblocks the chat input
  // (Send stays disabled while a proposal is pending). approveProposal() waits
  // for the apply to finish.
  await po.approveProposal();

  // 5) App is still responsive: a follow-up prompt completes normally.
  await po.sendPrompt("hello after stress");
});
