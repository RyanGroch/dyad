import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LanguageModelUsage } from "ai";

// Project-root `eval-results/` (never deleted, not tracked by git — see
// .gitignore). Layout:
//
//   eval-results/
//     <suite>/
//       <run-start-ts>__<model-label>/        (run folder)
//         <case-name>/                        (record folder)
//           record.json                       (full structured record)
//           record.txt                        (readable plaintext, every
//                                              tool call inline)
//           tool_calls/
//             01.txt                          (one file per tool call,
//             02.txt                           real newlines — not \n)
//             ...
//
// `<run-start-ts>` is captured once at module load so every case run in
// the same vitest process for the same model lands in one folder. The
// ISO-timestamp prefix makes `ls` return folders in chronological order.
const RESULTS_ROOT = resolve(__dirname, "../../../../eval-results");

// Captured once per module load. Shared by every `recordEvalRun` call
// from the same process so all cases from a single run cluster into
// one folder per model.
const RUN_START_TIMESTAMP = new Date().toISOString();

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LLMRequestRecord {
  stepIndex: number;
  timestamp: string;
  durationMs: number;
  usage: NormalizedUsage;
  finishReason: string | null;
}

export interface ToolCallRecord {
  timestamp: string;
  index: number;
  toolName: string;
  filePath: string;
  // Raw tool input arguments, keyed by the tool's parameter names
  // (e.g. `old_string`/`new_string` for search_replace, `content` for
  // write_file).
  args: Record<string, unknown>;
  fileBefore: string;
  fileAfter: string;
  // Unified diff from fileBefore → fileAfter for this single call.
  // Empty string when the call did not change the file.
  diff: string;
  // Whether the tool call completed successfully. Failed calls still get
  // recorded so the tool-call log reflects what the model actually tried,
  // not just what succeeded.
  succeeded: boolean;
  // Error message when succeeded=false; null otherwise.
  error: string | null;
}

export interface JudgeRecord {
  label: string;
  provider: string;
  modelName: string;
  durationMs: number;
  usage: NormalizedUsage;
  pass: boolean;
  explanation: string;
}

// MCP suite extensions. Optional so existing file-edit cases compile
// unchanged. Populated only by the `mcp_execute` suite.
export interface McpCallRecord {
  timestamp: string;
  index: number;
  jsName: string;
  serverName: string;
  toolName: string;
  args: unknown;
  result: unknown | null;
  durationMs: number;
  succeeded: boolean;
  error: string | null;
  /**
   * Deep-serialized error payload (own properties + recursive `.cause`
   * chain + any custom JSON-RPC fields like `.code` / `.data`).
   * `error` carries only `err.message`, which for MCP failures is often
   * something terse like `"MCP error -32602"` that loses the actual
   * server-side reason. `errorDetail` preserves the full context so
   * reviewers and the judge can see WHY a call failed (e.g. "did not
   * contain a required property of 'question'").
   */
  errorDetail?: unknown;
  consentGranted: boolean;
}

export interface SandboxScriptRecord {
  timestamp: string;
  index: number;
  script: string;
  description: string | null;
  output: string;
  executionMs: number;
  truncated: boolean;
  mcpCallIndexes: number[];
}

export interface SearchCallRecord {
  timestamp: string;
  index: number;
  query: string;
  server: string | null;
  returnedToolNames: string[];
  durationMs: number;
}

export interface EvalRunRecord {
  timestamp: string;
  suite: string;
  caseName: string;
  model: {
    label: string;
    provider: string;
    modelName: string;
    responseModelId: string | null;
  };
  prompt: {
    system: string;
    // Plain edit instructions for the case, without the file content
    // spliced in. Handy for skimming what the model was asked to do.
    instructions: string;
    // Full user-message content actually sent to the model (typically
    // the file contents followed by the instructions).
    user: string;
  };
  file: {
    name: string;
    before: string;
    after: string;
  };
  llm: {
    totalDurationMs: number;
    totalUsage: NormalizedUsage;
    requestCount: number;
    requests: LLMRequestRecord[];
  };
  toolCalls: ToolCallRecord[];
  // Unified diff between the original file (pre-first-tool-call) and
  // the final file (post-last-tool-call). Empty string when no change.
  diff: string;
  judge: JudgeRecord | null;
  passed: boolean;
  errorMessage: string | null;
  // MCP suite extensions (optional). Present only for `mcp_execute`.
  answer?: string;
  mcpCalls?: McpCallRecord[];
  sandboxScripts?: SandboxScriptRecord[];
  /**
   * `search_mcp_tools` calls (search suite only). Lets reviewers see each
   * query the model issued and which tools BM25 returned.
   */
  searchCalls?: SearchCallRecord[];
  /**
   * Raw XML emitted via `onXmlComplete` while the case ran. Mirrors
   * what the UI would render and includes the full MCP tool-call /
   * tool-result XML envelopes.
   */
  xmlEmissions?: string[];
  /**
   * The full dynamically-built `execute_sandbox_script` tool description
   * that the model saw — preamble + MCP type defs block. Captured so
   * reviewers can see exactly which MCP tools (and what TS signatures)
   * the model had access to.
   */
  executeSandboxScriptDescription?: string;
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function fsTimestamp(iso: string): string {
  // Colons/periods are legal on Linux but ugly and fragile across
  // filesystems. Replace so `2026-04-10T14:23:01.123Z` becomes
  // `2026-04-10T14-23-01-123Z`.
  return iso.replace(/[:.]/g, "-");
}

export function normalizeUsage(
  u: LanguageModelUsage | undefined,
): NormalizedUsage {
  const input = u?.inputTokens ?? 0;
  const output = u?.outputTokens ?? 0;
  const total = u?.totalTokens ?? input + output;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

function formatUsage(u: NormalizedUsage): string {
  return `input=${u.inputTokens} output=${u.outputTokens} total=${u.totalTokens}`;
}

function hr(char = "=", n = 72): string {
  return char.repeat(n);
}

function stringifyArg(value: unknown): { text: string; length: number } {
  if (typeof value === "string") {
    return { text: value, length: value.length };
  }
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return { text, length: text.length };
}

function formatToolCall(tc: ToolCallRecord): string {
  const parts: string[] = [];
  parts.push(hr("-"));
  const status = tc.succeeded ? "" : " [FAILED]";
  parts.push(`Tool call #${tc.index + 1} (${tc.toolName})${status}`);
  parts.push(`Timestamp: ${tc.timestamp}`);
  parts.push(`File:      ${tc.filePath}`);
  if (!tc.succeeded && tc.error) {
    parts.push(`Error:     ${tc.error}`);
  }
  parts.push("");
  for (const [key, value] of Object.entries(tc.args)) {
    const { text, length } = stringifyArg(value);
    parts.push(`----- ${key.toUpperCase()} (${length} chars) -----`);
    parts.push(text);
  }
  parts.push(`----- FILE BEFORE (${tc.fileBefore.length} chars) -----`);
  parts.push(tc.fileBefore);
  parts.push(`----- FILE AFTER (${tc.fileAfter.length} chars) -----`);
  parts.push(tc.fileAfter);
  parts.push(`----- DIFF (before → after) -----`);
  parts.push(tc.diff || "(no change)");
  return parts.join("\n") + "\n";
}

export function renderToolCallAsText(
  tc: ToolCallRecord,
  context: { suite: string; caseName: string; modelLabel: string },
): string {
  return (
    `${hr("=")}\n` +
    `Suite:     ${context.suite}\n` +
    `Case:      ${context.caseName}\n` +
    `Model:     ${context.modelLabel}\n` +
    `${hr("=")}\n` +
    `\n` +
    formatToolCall(tc)
  );
}

export function renderEvalRunAsText(record: EvalRunRecord): string {
  const lines: string[] = [];
  lines.push(hr("="));
  lines.push(`Suite:     ${record.suite}`);
  lines.push(`Case:      ${record.caseName}`);
  lines.push(
    `Model:     ${record.model.label} ` +
      `[${record.model.provider}/${record.model.modelName}]` +
      (record.model.responseModelId
        ? ` → ${record.model.responseModelId}`
        : ""),
  );
  lines.push(`Timestamp: ${record.timestamp}`);
  lines.push(`Passed:    ${record.passed}`);
  if (record.errorMessage) {
    lines.push(`Error:     ${record.errorMessage}`);
  }
  lines.push(hr("="));
  lines.push("");

  lines.push("System prompt");
  lines.push(hr("-"));
  lines.push(record.prompt.system);
  lines.push("");
  lines.push("Instructions");
  lines.push(hr("-"));
  lines.push(record.prompt.instructions);
  lines.push("");
  lines.push("User prompt (full)");
  lines.push(hr("-"));
  lines.push(record.prompt.user);
  lines.push("");

  lines.push("LLM");
  lines.push(`  Total duration: ${record.llm.totalDurationMs}ms`);
  lines.push(`  Requests:       ${record.llm.requestCount}`);
  lines.push(`  Total tokens:   ${formatUsage(record.llm.totalUsage)}`);
  for (const req of record.llm.requests) {
    lines.push(
      `    step ${req.stepIndex}: ${req.durationMs}ms, ` +
        `${formatUsage(req.usage)}, finish=${req.finishReason ?? "?"}`,
    );
  }
  lines.push("");

  lines.push(`Tool calls (${record.toolCalls.length})`);
  lines.push("");
  for (const tc of record.toolCalls) {
    lines.push(formatToolCall(tc));
  }

  if (record.sandboxScripts && record.sandboxScripts.length > 0) {
    lines.push(hr("="));
    lines.push(`Sandbox scripts (${record.sandboxScripts.length})`);
    lines.push(hr("="));
    for (const s of record.sandboxScripts) {
      lines.push(hr("-"));
      lines.push(
        `Script #${s.index + 1} — ${s.executionMs}ms${s.truncated ? " [truncated]" : ""}`,
      );
      if (s.description) lines.push(`Description: ${s.description}`);
      lines.push(`MCP calls in this script: ${s.mcpCallIndexes.length}`);
      lines.push("----- SCRIPT -----");
      lines.push(s.script);
      lines.push("----- OUTPUT -----");
      lines.push(s.output);
    }
    lines.push("");
  }

  if (record.searchCalls && record.searchCalls.length > 0) {
    lines.push(hr("="));
    lines.push(`MCP tool searches (${record.searchCalls.length})`);
    lines.push(hr("="));
    for (const s of record.searchCalls) {
      lines.push(hr("-"));
      const scope = s.server ? ` (server: ${s.server})` : "";
      lines.push(`Search #${s.index + 1}: "${s.query}"${scope}`);
      lines.push(`Duration: ${s.durationMs}ms`);
      lines.push(
        `Returned: ${s.returnedToolNames.length > 0 ? s.returnedToolNames.join(", ") : "(no matches)"}`,
      );
    }
    lines.push("");
  }

  if (record.mcpCalls && record.mcpCalls.length > 0) {
    lines.push(hr("="));
    lines.push(`MCP calls (${record.mcpCalls.length})`);
    lines.push(hr("="));
    for (const c of record.mcpCalls) {
      lines.push(hr("-"));
      const status = c.succeeded ? "" : " [FAILED]";
      const consent = c.consentGranted ? "" : " [CONSENT DENIED]";
      lines.push(
        `MCP call #${c.index + 1}: ${c.jsName} (${c.serverName}/${c.toolName})${status}${consent}`,
      );
      lines.push(`Duration: ${c.durationMs}ms`);
      lines.push("----- ARGS -----");
      lines.push(JSON.stringify(c.args, null, 2));
      lines.push("----- RESULT -----");
      lines.push(JSON.stringify(c.result, null, 2));
      if (!c.succeeded && c.error) {
        lines.push("----- ERROR -----");
        lines.push(c.error);
      }
    }
    lines.push("");
  }

  if (record.answer !== undefined) {
    lines.push(hr("="));
    lines.push("Final answer");
    lines.push(hr("="));
    lines.push(record.answer);
    lines.push("");
  }

  lines.push(hr("="));
  lines.push("Diff (original → final)");
  lines.push(hr("="));
  if (record.diff) {
    lines.push(record.diff);
  } else {
    lines.push("(no change)");
    lines.push("");
  }

  if (record.judge) {
    lines.push(hr("="));
    lines.push("Judge");
    lines.push(`  Identity: ${record.judge.label} [${record.judge.modelName}]`);
    lines.push(`  Duration: ${record.judge.durationMs}ms`);
    lines.push(`  Tokens:   ${formatUsage(record.judge.usage)}`);
    lines.push(`  Verdict:  ${record.judge.pass ? "PASS" : "FAIL"}`);
    lines.push(`  Explanation:`);
    for (const line of record.judge.explanation.split("\n")) {
      lines.push(`    ${line}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function recordDirFor(
  suite: string,
  caseName: string,
  modelLabel: string,
): string {
  const runDirName = `${fsTimestamp(RUN_START_TIMESTAMP)}__${sanitize(modelLabel)}`;
  return resolve(RESULTS_ROOT, sanitize(suite), runDirName, sanitize(caseName));
}

export async function recordEvalRun(record: EvalRunRecord): Promise<void> {
  const recordDir = recordDirFor(
    record.suite,
    record.caseName,
    record.model.label,
  );
  await mkdir(recordDir, { recursive: true });

  const writes: Promise<void>[] = [
    writeFile(
      resolve(recordDir, "record.json"),
      JSON.stringify(record, null, 2) + "\n",
    ),
    writeFile(resolve(recordDir, "record.txt"), renderEvalRunAsText(record)),
    writeDetailsFolder(recordDir, record),
  ];

  if (record.toolCalls.length > 0) {
    writes.push(writeToolCallsFolder(recordDir, record));
  }
  if (record.sandboxScripts && record.sandboxScripts.length > 0) {
    writes.push(writeSandboxScriptsFolder(recordDir, record));
  }
  if (record.mcpCalls && record.mcpCalls.length > 0) {
    writes.push(writeMcpCallsFolder(recordDir, record));
  }
  if (record.searchCalls && record.searchCalls.length > 0) {
    writes.push(writeSearchesFolder(recordDir, record));
  }

  await Promise.all(writes);
}

async function writeSearchesFolder(
  recordDir: string,
  record: EvalRunRecord,
): Promise<void> {
  const searches = record.searchCalls ?? [];
  if (searches.length === 0) return;
  const dir = resolve(recordDir, "mcp_searches");
  await mkdir(dir, { recursive: true });
  const padWidth = Math.max(2, String(searches.length).length);

  await Promise.all(
    searches.map(async (s) => {
      const base = String(s.index + 1).padStart(padWidth, "0");
      const splitDir = resolve(dir, base);
      await mkdir(splitDir, { recursive: true });

      const scope = s.server ? ` (server: ${s.server})` : "";
      const returned =
        s.returnedToolNames.length > 0
          ? s.returnedToolNames.map((n, i) => `  ${i + 1}. ${n}`).join("\n")
          : "  (no matches)";
      const combined =
        `${hr("=")}\n` +
        `MCP tool search #${s.index + 1}${scope}\n` +
        `Timestamp: ${s.timestamp}\n` +
        `Duration:  ${s.durationMs}ms\n` +
        `${hr("=")}\n\n` +
        `----- QUERY -----\n${s.query}\n\n` +
        `----- RETURNED (rank order) -----\n${returned}\n`;

      await Promise.all([
        writeFile(resolve(dir, `${base}.txt`), combined),
        writeFile(
          resolve(splitDir, "meta.txt"),
          `index:       ${s.index + 1}\n` +
            `timestamp:   ${s.timestamp}\n` +
            `server:      ${s.server ?? ""}\n` +
            `query:       ${s.query}\n` +
            `duration_ms: ${s.durationMs}\n`,
        ),
        writeFile(
          resolve(splitDir, "returned.json"),
          JSON.stringify(s.returnedToolNames, null, 2) + "\n",
        ),
      ]);
    }),
  );
}

async function writeSandboxScriptsFolder(
  recordDir: string,
  record: EvalRunRecord,
): Promise<void> {
  const scripts = record.sandboxScripts ?? [];
  if (scripts.length === 0) return;
  const dir = resolve(recordDir, "sandbox_scripts");
  await mkdir(dir, { recursive: true });
  const padWidth = Math.max(2, String(scripts.length).length);

  await Promise.all(
    scripts.map(async (s) => {
      const base = String(s.index + 1).padStart(padWidth, "0");
      const splitDir = resolve(dir, base);
      await mkdir(splitDir, { recursive: true });

      const combined =
        `${hr("=")}\n` +
        `Sandbox script #${s.index + 1}\n` +
        `Timestamp:  ${s.timestamp}\n` +
        `Duration:   ${s.executionMs}ms\n` +
        `Truncated:  ${s.truncated}\n` +
        (s.description ? `Description: ${s.description}\n` : "") +
        `MCP calls:  ${s.mcpCallIndexes.length}` +
        (s.mcpCallIndexes.length
          ? ` (indexes: ${s.mcpCallIndexes.map((i) => i + 1).join(", ")})`
          : "") +
        `\n${hr("=")}\n\n` +
        `----- SCRIPT (MustardScript) -----\n${s.script}\n\n` +
        `----- OUTPUT -----\n${s.output}\n`;

      await Promise.all([
        writeFile(resolve(dir, `${base}.txt`), combined),
        writeFile(resolve(splitDir, "script.js"), s.script + "\n"),
        writeFile(resolve(splitDir, "output.txt"), s.output + "\n"),
        writeFile(
          resolve(splitDir, "meta.txt"),
          `index:        ${s.index + 1}\n` +
            `timestamp:    ${s.timestamp}\n` +
            `description:  ${s.description ?? ""}\n` +
            `execution_ms: ${s.executionMs}\n` +
            `truncated:    ${s.truncated}\n` +
            `mcp_call_indexes: ${s.mcpCallIndexes
              .map((i) => i + 1)
              .join(", ")}\n`,
        ),
      ]);
    }),
  );
}

async function writeMcpCallsFolder(
  recordDir: string,
  record: EvalRunRecord,
): Promise<void> {
  const calls = record.mcpCalls ?? [];
  if (calls.length === 0) return;
  const dir = resolve(recordDir, "mcp_calls");
  await mkdir(dir, { recursive: true });
  const padWidth = Math.max(2, String(calls.length).length);

  await Promise.all(
    calls.map(async (c) => {
      const base = String(c.index + 1).padStart(padWidth, "0");
      const splitDir = resolve(dir, base);
      await mkdir(splitDir, { recursive: true });

      const status = c.succeeded ? "" : " [FAILED]";
      const consent = c.consentGranted ? "" : " [CONSENT DENIED]";
      const errorDetailJson =
        c.errorDetail !== undefined
          ? JSON.stringify(c.errorDetail, null, 2)
          : null;
      const combined =
        `${hr("=")}\n` +
        `MCP call #${c.index + 1}: ${c.jsName} (${c.serverName}/${c.toolName})${status}${consent}\n` +
        `Timestamp: ${c.timestamp}\n` +
        `Duration:  ${c.durationMs}ms\n` +
        `${hr("=")}\n\n` +
        `----- ARGS -----\n${JSON.stringify(c.args, null, 2)}\n\n` +
        `----- RESULT -----\n${JSON.stringify(c.result, null, 2)}\n` +
        (!c.succeeded && c.error ? `\n----- ERROR -----\n${c.error}\n` : "") +
        (errorDetailJson
          ? `\n----- ERROR DETAIL -----\n${errorDetailJson}\n`
          : "");

      const writes: Promise<void>[] = [
        writeFile(resolve(dir, `${base}.txt`), combined),
        writeFile(
          resolve(splitDir, "args.json"),
          JSON.stringify(c.args, null, 2) + "\n",
        ),
        writeFile(
          resolve(splitDir, "result.json"),
          JSON.stringify(c.result, null, 2) + "\n",
        ),
        writeFile(
          resolve(splitDir, "meta.txt"),
          `index:           ${c.index + 1}\n` +
            `timestamp:       ${c.timestamp}\n` +
            `js_name:         ${c.jsName}\n` +
            `server_name:     ${c.serverName}\n` +
            `tool_name:       ${c.toolName}\n` +
            `duration_ms:     ${c.durationMs}\n` +
            `succeeded:       ${c.succeeded}\n` +
            `consent_granted: ${c.consentGranted}\n` +
            (!c.succeeded && c.error ? `error:           ${c.error}\n` : ""),
        ),
      ];
      if (errorDetailJson) {
        writes.push(
          writeFile(
            resolve(splitDir, "error_detail.json"),
            errorDetailJson + "\n",
          ),
        );
      }
      await Promise.all(writes);
    }),
  );
}

async function writeToolCallsFolder(
  recordDir: string,
  record: EvalRunRecord,
): Promise<void> {
  const toolCallsDir = resolve(recordDir, "tool_calls");
  await mkdir(toolCallsDir, { recursive: true });
  const padWidth = Math.max(2, String(record.toolCalls.length).length);

  await Promise.all(
    record.toolCalls.map(async (tc) => {
      const base = String(tc.index + 1).padStart(padWidth, "0");

      // Combined summary (easy to scan in one file).
      const summaryWrite = writeFile(
        resolve(toolCallsDir, `${base}.txt`),
        renderToolCallAsText(tc, {
          suite: record.suite,
          caseName: record.caseName,
          modelLabel: record.model.label,
        }),
      );

      // Split views for easy per-piece inspection. Each file contains
      // the raw content — no headers — so it can be opened in an editor
      // with syntax highlighting matching the source file's extension.
      const splitDir = resolve(toolCallsDir, base);
      await mkdir(splitDir, { recursive: true });
      const ext = extensionFor(tc.filePath);

      const argLengths: string[] = [];
      const argWrites: Promise<void>[] = [];
      // One file per argument. Strings use the target file's extension so
      // they open with matching syntax highlighting; non-strings become
      // JSON blobs.
      for (const [key, value] of Object.entries(tc.args)) {
        const { text, length } = stringifyArg(value);
        const argExt = typeof value === "string" ? ext : ".json";
        argWrites.push(writeFile(resolve(splitDir, `${key}${argExt}`), text));
        argLengths.push(`${key}: ${length} chars`);
      }

      await Promise.all([
        summaryWrite,
        writeFile(resolve(splitDir, `file_before${ext}`), tc.fileBefore),
        writeFile(resolve(splitDir, `file_after${ext}`), tc.fileAfter),
        writeFile(resolve(splitDir, "diff.patch"), tc.diff || ""),
        ...argWrites,
        writeFile(
          resolve(splitDir, "meta.txt"),
          `index:     ${tc.index + 1}\n` +
            `tool:      ${tc.toolName}\n` +
            `timestamp: ${tc.timestamp}\n` +
            `file_path: ${tc.filePath}\n` +
            `succeeded: ${tc.succeeded}\n` +
            (tc.succeeded ? "" : `error:     ${tc.error ?? ""}\n`) +
            argLengths.map((l) => `${l}\n`).join("") +
            `file_before: ${tc.fileBefore.length} chars\n` +
            `file_after: ${tc.fileAfter.length} chars\n`,
        ),
      ]);
    }),
  );
}

async function writeDetailsFolder(
  recordDir: string,
  record: EvalRunRecord,
): Promise<void> {
  const detailsDir = resolve(recordDir, "details");
  await mkdir(detailsDir, { recursive: true });
  const ext = extensionFor(record.file.name);

  // Metadata mirrors the main record but drops the large content blobs
  // that already have their own files (file_before, file_after, overall
  // diff) and the per-tool-call details (tool_calls/ folder has them).
  const metadata = {
    timestamp: record.timestamp,
    suite: record.suite,
    caseName: record.caseName,
    model: record.model,
    prompt: record.prompt,
    file: { name: record.file.name },
    llm: record.llm,
    toolCallCount: record.toolCalls.length,
    judge: record.judge,
    passed: record.passed,
    errorMessage: record.errorMessage,
  };

  // Skip file_before / file_after / diff.patch when the case did not
  // operate on a file fixture (e.g. MCP cases use `file.name: "(none)"`
  // and empty before/after). Writing those as empty files adds noise
  // and confuses reviewers into thinking something went wrong.
  const hasFileFixture =
    record.file.before.length > 0 || record.file.after.length > 0;

  const writes: Promise<void>[] = [
    writeFile(resolve(detailsDir, "system_prompt.txt"), record.prompt.system),
    writeFile(
      resolve(detailsDir, "instructions.txt"),
      record.prompt.instructions,
    ),
    writeFile(resolve(detailsDir, "user_prompt.txt"), record.prompt.user),
    writeFile(
      resolve(detailsDir, "metadata.json"),
      JSON.stringify(metadata, null, 2) + "\n",
    ),
    writeFile(
      resolve(detailsDir, "metadata.txt"),
      renderMetadataAsText(metadata),
    ),
  ];
  if (hasFileFixture) {
    writes.push(
      writeFile(resolve(detailsDir, `file_before${ext}`), record.file.before),
      writeFile(resolve(detailsDir, `file_after${ext}`), record.file.after),
      writeFile(resolve(detailsDir, "diff.patch"), record.diff || ""),
    );
  }
  if (record.executeSandboxScriptDescription) {
    // The dynamic tool description the model saw — preamble + MCP type
    // defs block. Written as Markdown so the embedded ```ts fences in
    // the description render in code-block-aware viewers.
    writes.push(
      writeFile(
        resolve(detailsDir, "execute_sandbox_script_description.md"),
        record.executeSandboxScriptDescription,
      ),
    );
  }
  if (record.answer !== undefined) {
    writes.push(writeFile(resolve(detailsDir, "answer.txt"), record.answer));
  }
  await Promise.all(writes);
}

function renderMetadataAsText(m: {
  timestamp: string;
  suite: string;
  caseName: string;
  model: EvalRunRecord["model"];
  prompt: EvalRunRecord["prompt"];
  file: { name: string };
  llm: EvalRunRecord["llm"];
  toolCallCount: number;
  judge: JudgeRecord | null;
  passed: boolean;
  errorMessage: string | null;
}): string {
  const lines: string[] = [];
  lines.push(hr("="));
  lines.push(`Suite:     ${m.suite}`);
  lines.push(`Case:      ${m.caseName}`);
  lines.push(`File:      ${m.file.name}`);
  lines.push(
    `Model:     ${m.model.label} ` +
      `[${m.model.provider}/${m.model.modelName}]` +
      (m.model.responseModelId ? ` → ${m.model.responseModelId}` : ""),
  );
  lines.push(`Timestamp: ${m.timestamp}`);
  lines.push(`Passed:    ${m.passed}`);
  if (m.errorMessage) lines.push(`Error:     ${m.errorMessage}`);
  lines.push(hr("="));
  lines.push("");

  lines.push("LLM");
  lines.push(`  Total duration: ${m.llm.totalDurationMs}ms`);
  lines.push(`  Requests:       ${m.llm.requestCount}`);
  lines.push(`  Total tokens:   ${formatUsage(m.llm.totalUsage)}`);
  for (const req of m.llm.requests) {
    lines.push(
      `    step ${req.stepIndex}: ${req.durationMs}ms, ` +
        `${formatUsage(req.usage)}, finish=${req.finishReason ?? "?"}`,
    );
  }
  lines.push("");
  lines.push(`Tool call count: ${m.toolCallCount}`);
  lines.push("");

  lines.push("System prompt");
  lines.push(hr("-"));
  lines.push(m.prompt.system);
  lines.push("");
  lines.push("Instructions");
  lines.push(hr("-"));
  lines.push(m.prompt.instructions);
  lines.push("");

  if (m.judge) {
    lines.push(hr("="));
    lines.push("Judge");
    lines.push(`  Identity: ${m.judge.label} [${m.judge.modelName}]`);
    lines.push(`  Provider: ${m.judge.provider}`);
    lines.push(`  Duration: ${m.judge.durationMs}ms`);
    lines.push(`  Tokens:   ${formatUsage(m.judge.usage)}`);
    lines.push(`  Verdict:  ${m.judge.pass ? "PASS" : "FAIL"}`);
    lines.push(`  Explanation:`);
    for (const line of m.judge.explanation.split("\n")) {
      lines.push(`    ${line}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function extensionFor(filePath: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(filePath);
  return match ? match[0] : ".txt";
}
