import { safeSend } from "../utils/safe_sender";
import { cleanFullResponse } from "../utils/cleanFullResponse";
import { computeStreamingPatch } from "../utils/stream_text_utils";
import { TOOL_CALL_TAGS } from "@/lib/streamingMessageParser";

/**
 * Closing-tag regex for every dyad-* tool call. Built once at module load
 * from TOOL_CALL_TAGS so the test stream's tier selector can count tool
 * calls in `lastSentContent` without re-deriving the alternation per send.
 */
const TOOL_CALL_CLOSE_TAG_RE = (() => {
  const alts = [...TOOL_CALL_TAGS]
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  return new RegExp(`</(?:${alts})>`, "g");
})();

function countToolCallsClosed(content: string): number {
  TOOL_CALL_CLOSE_TAG_RE.lastIndex = 0;
  let n = 0;
  while (TOOL_CALL_CLOSE_TAG_RE.exec(content) !== null) n++;
  return n;
}

interface BackpressureTier {
  threshold: number;
  minIntervalMs: number;
}

const TIER_LOW: BackpressureTier = { threshold: 100, minIntervalMs: 100 };
const TIER_MID: BackpressureTier = { threshold: 20, minIntervalMs: 250 };
const TIER_HIGH: BackpressureTier = { threshold: 1, minIntervalMs: 500 };

/**
 * Pick the backpressure tier given how much content has been sent so far.
 * Tiers are monotonic upgrades only — see `streamTestResponse` for the
 * locking. OR semantics: any metric crossing the threshold triggers an
 * upgrade.
 */
function pickTier(bytesSent: number, toolCallsSent: number): BackpressureTier {
  if (toolCallsSent >= 50 || bytesSent >= 200_000) return TIER_HIGH;
  if (toolCallsSent >= 10 || bytesSent >= 100_000) return TIER_MID;
  return TIER_LOW;
}

function tierLevel(t: BackpressureTier): number {
  if (t === TIER_HIGH) return 2;
  if (t === TIER_MID) return 1;
  return 0;
}

// e.g. [dyad-qa=add-dep]
// Canned responses for test prompts
const TEST_RESPONSES: Record<string, string> = {
  "ts-error": `This will get a TypeScript error.
  
  <dyad-write path="src/bad-file.ts" description="This will get a TypeScript error.">
  import NonExistentClass from 'non-existent-class';

  const x = new Object();
  x.nonExistentMethod();
  </dyad-write>
  
  EOM`,
  "add-dep": `I'll add that dependency for you.
  
  <dyad-add-dependency packages="deno"></dyad-add-dependency>
  
  EOM`,
  "add-non-existing-dep": `I'll add that dependency for you.
  
  <dyad-add-dependency packages="@angular/does-not-exist"></dyad-add-dependency>
  
  EOM`,
  "add-multiple-deps": `I'll add that dependency for you.
  
  <dyad-add-dependency packages="react-router-dom react-query"></dyad-add-dependency>
  
  EOM`,
  write: `Hello world
  <dyad-write path="src/hello.ts" content="Hello world">
  console.log("Hello world");
  </dyad-write>
  EOM`,
  "string-literal-leak": `BEFORE TAG
  <dyad-write path="src/pages/locations/neighborhoods/louisville/Highlands.tsx" description="Updating Highlands neighborhood page to use <a> tags.">
import React from 'react';
</dyad-write>
AFTER TAG
`,
  "stress-many-writes": `Generating 10000 ~100-line files for stress test.

${Array.from({ length: 10000 }, (_, i) => {
  const fields = Array.from(
    { length: 20 },
    (_, j) => `  field_${j}: ${i * 20 + j},`,
  ).join("\n");
  const helpers = Array.from(
    { length: 20 },
    (_, j) =>
      `export function helper_${i}_${j}(x: number): number {
  return x + id${i} + ${j};
}`,
  ).join("\n");
  return `<dyad-write path="src/stress/file_${i}.ts" description="stress file ${i}">
export const id${i} = ${i};
export const name${i} = "file_${i}";

export interface Meta${i} {
  id: number;
  name: string;
  index: number;
}

export const meta${i}: Meta${i} = {
  id: id${i},
  name: name${i},
  index: ${i},
};

export const data${i} = {
${fields}
};

export function get${i}(): number {
  return id${i};
}

export function describe${i}(): string {
  return \`\${name${i}}:\${id${i}}\`;
}

${helpers}

export function summarize${i}(): string {
  const parts = [
    describe${i}(),
    String(get${i}()),
    JSON.stringify(meta${i}),
  ];
  return parts.join("|");
}

export default meta${i};
</dyad-write>`;
}).join("\n")}

EOM`,
};

/**
 * Checks if a prompt is a test prompt and returns the corresponding canned response
 * @param prompt The user prompt
 * @returns The canned response if it's a test prompt, null otherwise
 */
export function getTestResponse(prompt: string): string | null {
  const match = prompt.match(/\[dyad-qa=([^\]]+)\]/);
  if (match) {
    const testKey = match[1];
    return TEST_RESPONSES[testKey] || null;
  }
  return null;
}

/**
 * Per-stream ack state for the canned test stream backpressure path. Real
 * LLM streams do not register entries here, so `noteAck` is a no-op for
 * them.
 */
type AckEntry = { lastAcked: number };
const ackState = new Map<number, AckEntry>();

export function noteAck(chatId: number, lastSeq: number): void {
  const entry = ackState.get(chatId);
  if (!entry) return;
  if (lastSeq > entry.lastAcked) {
    entry.lastAcked = lastSeq;
  }
}

function clearAck(chatId: number): void {
  ackState.delete(chatId);
}

/**
 * Streams a canned test response to the client incrementally via tail-only
 * streaming patches, mirroring the real LLM path. The renderer applies each
 * patch to its local copy of the placeholder assistant message.
 *
 * Adaptive ack-based backpressure: each iteration appends to fullResponse
 * and increments currentSeq. The IPC send is conditional on (a) in-flight
 * headroom (`lastSentSeq - lastAcked <= tier.threshold`) and (b) elapsed
 * time since last send (`>= tier.minIntervalMs`). Tier escalates once as
 * the response grows past defined byte / tool-call thresholds; downgrades
 * are not allowed (locked monotonic upgrade).
 *
 * The 10ms loop yield lets the noteAck IPC handler run; without it, the
 * synchronous loop monopolizes the main process and acks are never
 * observed.
 *
 * @param event The IPC event
 * @param chatId The chat ID
 * @param testResponse The canned response to stream
 * @param abortController The abort controller for this stream
 * @param placeholderAssistantMessageId DB id of the placeholder assistant message to update incrementally
 * @returns The full streamed response
 */
export async function streamTestResponse(
  event: Electron.IpcMainInvokeEvent,
  chatId: number,
  testResponse: string,
  abortController: AbortController,
  placeholderAssistantMessageId: number,
): Promise<string> {
  console.log(`Using canned response for test prompt`);

  const chunks = testResponse.split(" ");
  let fullResponse = "";
  let lastSentContent = "";
  let currentSeq = 0;
  let lastSentSeq = 0;
  let lastSentAt = 0;
  let tier: BackpressureTier = TIER_LOW;

  ackState.set(chatId, { lastAcked: 0 });

  try {
    for (const chunk of chunks) {
      if (abortController.signal.aborted) break;

      fullResponse += chunk + " ";
      fullResponse = cleanFullResponse(fullResponse);
      currentSeq++;

      const lastAcked = ackState.get(chatId)?.lastAcked ?? 0;
      const inFlight = lastSentSeq - lastAcked;
      const now = Date.now();
      const sinceLastSend = now - lastSentAt;

      if (
        inFlight <= tier.threshold &&
        sinceLastSend >= tier.minIntervalMs
      ) {
        const patch = computeStreamingPatch(fullResponse, lastSentContent);
        if (patch) {
          safeSend(event.sender, "chat:response:chunk", {
            chatId,
            streamingMessageId: placeholderAssistantMessageId,
            streamingPatch: patch,
            chunkSeq: currentSeq,
          });
          lastSentContent = fullResponse;
          lastSentSeq = currentSeq;
          lastSentAt = now;

          // Re-evaluate tier after each successful send. Locked monotonic
          // upgrade: the next tier replaces only if it represents a
          // stricter regime than the current one.
          const sentBytes = lastSentContent.length;
          const sentToolCalls = countToolCallsClosed(lastSentContent);
          const candidate = pickTier(sentBytes, sentToolCalls);
          if (tierLevel(candidate) > tierLevel(tier)) {
            tier = candidate;
          }
        }
      }

      await new Promise<void>((resolve) => setTimeout(() => resolve(), 10));
    }

    // Final flush: guarantee the renderer ends with the complete response,
    // even if the last iterations were skipped due to backpressure.
    if (!abortController.signal.aborted && lastSentSeq < currentSeq) {
      const patch = computeStreamingPatch(fullResponse, lastSentContent);
      if (patch) {
        safeSend(event.sender, "chat:response:chunk", {
          chatId,
          streamingMessageId: placeholderAssistantMessageId,
          streamingPatch: patch,
          chunkSeq: currentSeq,
        });
        lastSentContent = fullResponse;
      }
      lastSentSeq = currentSeq;
    }
  } finally {
    clearAck(chatId);
  }

  return fullResponse;
}
