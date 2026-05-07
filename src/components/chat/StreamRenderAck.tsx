import { useEffect, useLayoutEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { renderBenchByChatIdAtom } from "@/atoms/chatAtoms";

const FALLBACK_MS = 500;
// Ring-buffer cap. 500 samples × 4 stages = 2k floats; trivial cost.
// Stress fixtures emit 5k–10k+ chunks, so we keep a sliding window of
// the most recent 500 to bound percentile calc cost and reflect current
// render perf rather than warm-up artifacts.
const SAMPLE_CAP = 500;
// Emit a summary line every N samples. 100 ≈ 1 line/sec at typical
// stress-fixture rates without flooding the console.
const SUMMARY_EVERY = 100;

type Stage = "ipc" | "render" | "paint" | "total";
const STAGES: readonly Stage[] = ["ipc", "render", "paint", "total"];

interface Aggregator {
  count: number;
  buffers: Record<Stage, number[]>;
  /** Insert position for the ring buffer (only matters once count > cap). */
  cursor: number;
}

function createAggregator(): Aggregator {
  return {
    count: 0,
    cursor: 0,
    buffers: {
      ipc: [],
      render: [],
      paint: [],
      total: [],
    },
  };
}

function record(agg: Aggregator, sample: Record<Stage, number>): void {
  for (const stage of STAGES) {
    const buf = agg.buffers[stage];
    if (buf.length < SAMPLE_CAP) {
      buf.push(sample[stage]);
    } else {
      buf[agg.cursor] = sample[stage];
    }
  }
  if (agg.buffers.ipc.length >= SAMPLE_CAP) {
    agg.cursor = (agg.cursor + 1) % SAMPLE_CAP;
  }
  agg.count++;
}

interface Stats {
  n: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

function computeStats(buf: number[]): Stats | null {
  if (buf.length === 0) return null;
  const sorted = buf.slice().sort((a, b) => a - b);
  let sum = 0;
  for (const v of sorted) sum += v;
  const pick = (q: number) => {
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[idx];
  };
  return {
    n: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
  };
}

function fmt(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function formatStats(stage: Stage, s: Stats): string {
  return (
    `${stage}: n=${s.n} mean=${fmt(s.mean)} p50=${fmt(s.p50)} ` +
    `p95=${fmt(s.p95)} p99=${fmt(s.p99)} min=${fmt(s.min)} max=${fmt(s.max)}`
  );
}

function logSummary(
  chatId: number,
  totalSeen: number,
  agg: Aggregator,
  reason: "rolling" | "final",
): void {
  const lines: string[] = [];
  for (const stage of STAGES) {
    const stats = computeStats(agg.buffers[stage]);
    if (stats) lines.push("  " + formatStats(stage, stats));
  }
  if (lines.length === 0) return;
  console.log(
    `[render-bench-summary] chat=${chatId} total-samples=${totalSeen} ` +
      `window=${agg.buffers.ipc.length} reason=${reason}\n` +
      lines.join("\n"),
  );
}

/**
 * Render-bench sentinel for the canned test stream.
 *
 * Reads the latest {seq, emitTs, recvTs} sample for `chatId` from the
 * render-bench atom. On each new seq, captures `commitTs` in
 * useLayoutEffect (after React commit) and `paintTs` after a double rAF
 * (after the browser paints the committed DOM). Logs per-chunk deltas
 * and rolling distribution summaries.
 *
 * All timestamps use `performance.timeOrigin + performance.now()` so
 * they share a Unix-epoch origin and are subtractable across the main
 * and renderer processes.
 *
 * Test-only: the sample atom is only written when the chunk carries
 * `chunkSeq`, which the canned test stream emits and real LLM streams
 * omit. Mounting in production is a no-op (no atom updates → no logs).
 */
export function StreamRenderAck({ chatId }: { chatId: number }) {
  const benchByChatId = useAtomValue(renderBenchByChatIdAtom);
  const sample = benchByChatId.get(chatId);
  const seq = sample?.seq;
  const lastLoggedSeqRef = useRef<number | undefined>(undefined);
  const aggRef = useRef<Aggregator>(createAggregator());

  useLayoutEffect(() => {
    if (!sample || sample.seq === lastLoggedSeqRef.current) return;
    const commitTs = performance.timeOrigin + performance.now();
    const { seq: capturedSeq, emitTs, recvTs } = sample;
    lastLoggedSeqRef.current = capturedSeq;

    let cancelled = false;
    let raf2Id: number | undefined;
    const fallback = window.setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      finish(performance.timeOrigin + performance.now(), "fallback");
    }, FALLBACK_MS);

    const raf1Id = requestAnimationFrame(() => {
      raf2Id = requestAnimationFrame(() => {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(fallback);
        finish(performance.timeOrigin + performance.now(), "paint");
      });
    });

    function finish(paintTs: number, source: "paint" | "fallback") {
      const ipcMs = recvTs - emitTs;
      const renderMs = commitTs - recvTs;
      const paintMs = paintTs - commitTs;
      const totalMs = paintTs - emitTs;

      const agg = aggRef.current;
      record(agg, {
        ipc: ipcMs,
        render: renderMs,
        paint: paintMs,
        total: totalMs,
      });

      console.log(
        `[render-bench] chat=${chatId} seq=${capturedSeq} ` +
          `ipc=${fmt(ipcMs)} render=${fmt(renderMs)} ` +
          `paint=${fmt(paintMs)} total=${fmt(totalMs)} (${source})`,
      );

      if (agg.count % SUMMARY_EVERY === 0) {
        logSummary(chatId, agg.count, agg, "rolling");
      }
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf1Id);
      if (raf2Id !== undefined) cancelAnimationFrame(raf2Id);
      clearTimeout(fallback);
    };
  }, [chatId, sample, seq]);

  // Final summary on unmount (stream end / chat switch). The
  // aggregator only carries data when at least one chunk was recorded.
  useEffect(() => {
    const agg = aggRef.current;
    return () => {
      if (agg.count > 0) {
        logSummary(chatId, agg.count, agg, "final");
      }
    };
  }, [chatId]);

  return null;
}
