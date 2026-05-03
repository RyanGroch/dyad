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

/**
 * Streams a canned test response to the client
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

  const chunks = testResponse.split(" ");
  let fullResponse = "";

  let num = 0;
  // Throttle IPC sends in the test path only so the renderer can keep up
  // when the canned response is large. Real LLM streaming intentionally
  // skips this so we observe true backpressure behavior during experiments.
  const SEND_INTERVAL_MS = 16;
  let lastSentAt = 0;

  for (const chunk of chunks) {
    if (abortController.signal.aborted) {
      break;
    }

    fullResponse += chunk + " ";
    fullResponse = cleanFullResponse(fullResponse);

    const now = Date.now();
    if (now - lastSentAt >= SEND_INTERVAL_MS) {
      safeSend(event.sender, "chat:response:chunk", {
        chatId,
        streamingMessageId: placeholderAssistantMessageId,
        streamingContent: fullResponse,
      });
      lastSentAt = now;
      console.log(`SENT CHUNK ${++num} : ${chunk}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Always flush the final accumulated content so the renderer ends in sync
  // with the full canned response, even if the last iteration was throttled.
  if (!abortController.signal.aborted) {
    safeSend(event.sender, "chat:response:chunk", {
      chatId,
      streamingMessageId: placeholderAssistantMessageId,
      streamingContent: fullResponse,
    });
  }

  return fullResponse;
}
