import { safeSend } from "../utils/safe_sender";
import { cleanFullResponse } from "../utils/cleanFullResponse";

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
  "stress-many-writes": `Generating 100 small files for stress test.

${Array.from(
  { length: 5000 },
  (_, i) =>
    `<dyad-write path="src/stress/file_${i}.ts" description="stress file ${i}">
export const id${i} = ${i};
export const name${i} = "file_${i}";
export function get${i}() {
  return id${i};
}
export function describe${i}() {
  return \`\${name${i}}:\${id${i}}\`;
}
export const meta${i} = { id: id${i}, name: name${i} };
export default meta${i};
</dyad-write>`,
).join("\n")}

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

// Ack-based backpressure state for the canned test stream.
// Real LLM streams do not register entries here, so noteAck is a no-op for them.
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
 * Streams a canned test response to the client.
 *
 * Uses adaptive ack-based backpressure: the loop never blocks on the
 * renderer. Each iteration appends to fullResponse and increments
 * currentSeq. The IPC send is conditional on in-flight headroom
 * (lastSentSeq - lastAcked <= STRESS_BACKPRESSURE_THRESHOLD); when the
 * renderer is behind, sends are skipped while content keeps growing,
 * so the next allowed send naturally coalesces. Effective send rate
 * tracks whatever rate the renderer can sustain.
 *
 * Yields to the event loop every YIELD_EVERY_N_CHUNKS iterations so
 * the noteAck IPC handler can run; without yielding, the synchronous
 * for-loop monopolizes the main process and acks are never observed.
 *
 * @param event The IPC event
 * @param chatId The chat ID
 * @param testResponse The canned response to stream
 * @param abortController The abort controller for this stream
 * @param placeholderAssistantMessageId The DB id of the placeholder assistant message to update incrementally
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

  const STRESS_BACKPRESSURE_THRESHOLD = 1;
  // Hard floor on send interval so the renderer never receives more than
  // one chunk per MIN_SEND_INTERVAL_MS, regardless of how fast the loop
  // produces content. Sits on top of the adaptive backpressure gate.
  const MIN_SEND_INTERVAL_MS = 500;

  const chunks = testResponse.split(" ");
  let fullResponse = "";
  let currentSeq = 0;
  let lastSentSeq = 0;
  let lastSentAt = 0;

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
        inFlight <= STRESS_BACKPRESSURE_THRESHOLD &&
        sinceLastSend >= MIN_SEND_INTERVAL_MS
      ) {
        safeSend(event.sender, "chat:response:chunk", {
          chatId,
          streamingMessageId: placeholderAssistantMessageId,
          streamingContent: fullResponse,
          chunkSeq: currentSeq,
        });
        lastSentSeq = currentSeq;
        lastSentAt = now;
        console.log(
          `[stress] SEND seq=${currentSeq} inFlight=${currentSeq - lastAcked}`,
        );
      }

      await new Promise<void>((res) => setTimeout(() => res(undefined), 10));
    }

    // Final flush: guarantee the renderer ends with the complete response,
    // even if the last iterations were skipped due to backpressure.
    if (!abortController.signal.aborted && lastSentSeq < currentSeq) {
      safeSend(event.sender, "chat:response:chunk", {
        chatId,
        streamingMessageId: placeholderAssistantMessageId,
        streamingContent: fullResponse,
        chunkSeq: currentSeq,
      });
      lastSentSeq = currentSeq;
      console.log(`[stress] FINAL FLUSH seq=${currentSeq}`);
    }
  } finally {
    clearAck(chatId);
  }

  return fullResponse;
}
