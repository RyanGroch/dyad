import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Tool } from "ai";
import {
  executeSandboxScriptTool,
  buildExecuteSandboxScriptDescription,
} from "@/pro/main/ipc/handlers/local_agent/tools/execute_sandbox_script";
import { setChatSummaryTool } from "@/pro/main/ipc/handlers/local_agent/tools/set_chat_summary";
import { updateTodosTool } from "@/pro/main/ipc/handlers/local_agent/tools/update_todos";
import { searchReplaceTool } from "@/pro/main/ipc/handlers/local_agent/tools/search_replace";
import { writeFileTool } from "@/pro/main/ipc/handlers/local_agent/tools/write_file";
import { grepTool } from "@/pro/main/ipc/handlers/local_agent/tools/grep";
import { searchMcpToolsTool } from "@/pro/main/ipc/handlers/local_agent/tools/search_mcp_tools";
import type { AgentContext } from "@/pro/main/ipc/handlers/local_agent/tools/types";
import type { McpEvalCase } from "./cases";
import { getEvalMcpDefs, notifyEvalSearchCall } from "./mcp_registry";

// Bridges the eval harness to the production `execute_sandbox_script`
// tool. The tool's `execute` is reused as-is — we only build an
// `AgentContext` that records XML emissions and intercept the per-call
// MCP transcript via the test-only `recordMcpCall` callback.

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
  // See `helpers/eval_recorder.ts` for why `errorDetail` exists. Mirrors
  // that field so the harness's in-memory record matches the persisted
  // shape 1:1.
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
  /** Tool names (raw, server prefix stripped) the BM25 search returned. */
  returnedToolNames: string[];
  durationMs: number;
}

export interface McpRunState {
  // Final assistant text after the model finishes. Set by the runner.
  answer: string;
  mcpCalls: McpCallRecord[];
  sandboxScripts: SandboxScriptRecord[];
  /**
   * `search_mcp_tools` calls the model made (search suite only). Empty for
   * the inline `mcp_execute` suite, which never registers the search tool.
   */
  searchCalls: SearchCallRecord[];
  /**
   * XML emitted by the sandbox tool (mirrors `ctx.onXmlComplete`). Kept
   * for the record file so reviewers can see exactly what the UI would
   * have rendered.
   */
  xmlEmissions: string[];
  abortSignal?: AbortSignal;
}

export interface BuildMcpAgentContextParams {
  case: McpEvalCase;
  state: McpRunState;
  fixtureOrigin: string;
  abortSignal?: AbortSignal;
}

/**
 * Create a throwaway app dir for the case. The sandbox tool will
 * resolve `read_file` / `list_files` against this directory. For cases
 * that need an `instructions.txt` (or similar setup file), the runner
 * writes it here before invoking the model.
 *
 * Seeds a minimal stub project (package.json + README.md) so the
 * production agent prompt's "explore the codebase" instinct doesn't
 * send the model into a multi-turn filesystem spiral when the dir is
 * empty. Real production runs never hit an empty app dir — there's
 * always a project there — so seeding stubs removes scaffold-induced
 * noise without obscuring real MCP-skill signal.
 */
export function createCaseAppDir(): string {
  const dir = mkdtempSync(resolve(tmpdir(), "dyad-mcp-eval-"));
  const fs = require("node:fs") as typeof import("node:fs");
  fs.writeFileSync(
    resolve(dir, "package.json"),
    JSON.stringify(
      {
        name: "mcp-eval-fixture-app",
        version: "0.0.0",
        private: true,
        description:
          "Minimal stub project used by the Dyad MCP eval suite. Not a real app.",
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(
    resolve(dir, "README.md"),
    "# MCP eval fixture app\n\n" +
      "This is a throwaway directory used by the Dyad MCP eval suite. " +
      "It contains no real source code. Cases should use their " +
      "registered MCP tools for real work, not the file host functions.\n",
  );
  return dir;
}

export async function writeCaseSetupFile(
  appPath: string,
  fileName: string,
  contents: string,
): Promise<void> {
  await writeFile(resolve(appPath, fileName), contents, "utf-8");
}

/**
 * Builds an `AgentContext` shaped exactly like production but with
 * IPC-style sinks redirected into the eval state. The capability map
 * used inside `execute_sandbox_script` will still call
 * `requireMcpToolConsent`, so the harness file mocks that module too.
 */
export function buildMcpAgentContext(
  params: BuildMcpAgentContextParams & { appPath: string },
): AgentContext {
  const { state, abortSignal, appPath } = params;
  return {
    // Renderer event is only used by `requireMcpToolConsent`, which the
    // eval suite mocks at the module level. An empty object is fine.
    event: {} as AgentContext["event"],
    appId: 1,
    appPath,
    referencedApps: new Map(),
    chatId: 1,
    supabaseProjectId: null,
    supabaseOrganizationSlug: null,
    neonProjectId: null,
    neonActiveBranchId: null,
    frameworkType: null,
    messageId: 1,
    isSharedModulesChanged: false,
    isDyadPro: false,
    todos: [],
    dyadRequestId: "mcp-eval",
    fileEditTracker: {},
    onXmlStream: () => {},
    onXmlComplete: (xml) => {
      state.xmlEmissions.push(xml);
    },
    requireConsent: async () => true,
    appendUserMessage: () => {},
    onUpdateTodos: () => {},
    // Production injects MCP host functions into the sandbox from these
    // two fields (set by `local_agent_handler`), gating on
    // `mcpToolsEnabled`. The eval always runs the MCP-in-sandbox path
    // (never read-only / plan mode), so enable it and supply the same
    // defs the registry feeds to the mocked `collectMcpToolDefs`.
    mcpToolsEnabled: true,
    mcpToolDefs: getEvalMcpDefs(),
    abortSignal,
  };
}

/**
 * Build no-op AI-SDK `Tool` stubs for the production toolset. The MCP
 * suite uses the production system prompt, which expects these tools to
 * exist (`set_chat_summary`, `update_todos`, etc.). Without them the
 * model wastes turns calling missing tools and gets confused.
 *
 * Stubs reuse the production tool's `description` + `inputSchema` so
 * the model sees the same surface as prod, but `execute` is a no-op
 * that returns a benign success string. The MCP cases don't need these
 * tools to do real work — they exist purely to prevent prompt/toolset
 * mismatch.
 */
export function buildProductionToolStubs(): Record<string, Tool> {
  const noopExecute = (acknowledgement: string) => async (): Promise<string> =>
    acknowledgement;

  return {
    [setChatSummaryTool.name]: {
      description: setChatSummaryTool.description,
      inputSchema: setChatSummaryTool.inputSchema,
      execute: noopExecute("Chat summary set."),
    },
    [updateTodosTool.name]: {
      description: updateTodosTool.description,
      inputSchema: updateTodosTool.inputSchema,
      execute: noopExecute("Todos updated."),
    },
    [searchReplaceTool.name]: {
      description: searchReplaceTool.description,
      inputSchema: searchReplaceTool.inputSchema,
      execute: noopExecute("Edit applied."),
    },
    [writeFileTool.name]: {
      description: writeFileTool.description,
      inputSchema: writeFileTool.inputSchema,
      execute: noopExecute("File written."),
    },
    [grepTool.name]: {
      description: grepTool.description,
      inputSchema: grepTool.inputSchema,
      execute: noopExecute("No matches."),
    },
  };
}

/**
 * Build the AI-SDK `Tool` that the model will see. Same as
 * `executeSandboxScriptTool` but with the dynamic description baked in
 * and the production `execute` wrapped so the harness can record one
 * `SandboxScriptRecord` per call.
 */
export async function buildExecuteSandboxScriptHarnessTool(params: {
  case: McpEvalCase;
  state: McpRunState;
  ctx: AgentContext;
  /**
   * When true, build the search-mode description (server inventory only,
   * no inlined declarations) and the model must discover tools via
   * `search_mcp_tools`. Matches production with `enableMcpToolSearch` on.
   * Defaults to false: the inline-type-defs description prod emits by
   * default.
   */
  useSearch?: boolean;
}): Promise<{ tool: Tool; description: string }> {
  // Pass the per-turn defs to match production's per-turn description. With
  // `useSearch` off the declarations are inlined; with it on the model is
  // pointed at `search_mcp_tools` instead (prod's `enableMcpToolSearch`).
  const description = await buildExecuteSandboxScriptDescription(
    getEvalMcpDefs(),
    { useSearch: params.useSearch ?? false },
  );
  const tool: Tool = {
    description,
    inputSchema: executeSandboxScriptTool.inputSchema,
    execute: async (
      args: Parameters<typeof executeSandboxScriptTool.execute>[0],
    ) => {
      const index = params.state.sandboxScripts.length;
      const startMcpCount = params.state.mcpCalls.length;
      const startedAt = Date.now();
      let output = "";
      let truncated = false;
      try {
        const result = await executeSandboxScriptTool.execute(args, params.ctx);
        // Tool returns a JSON string from `executeSandboxScriptInProcess`.
        // Parse defensively — fall back to raw text on shape mismatch.
        try {
          const parsed = JSON.parse(result) as {
            value?: string;
            truncated?: boolean;
          };
          output = parsed.value ?? "";
          truncated = !!parsed.truncated;
        } catch {
          output = result;
        }
        return result;
      } finally {
        const endMcpCount = params.state.mcpCalls.length;
        params.state.sandboxScripts.push({
          timestamp: new Date().toISOString(),
          index,
          script: args.script,
          description: args.description ?? null,
          output,
          executionMs: Date.now() - startedAt,
          truncated,
          mcpCallIndexes: Array.from(
            { length: endMcpCount - startMcpCount },
            (_, i) => startMcpCount + i,
          ),
        });
      }
    },
  };
  return { tool, description };
}

/**
 * Parse the `declare function <jsName>(` identifiers out of a
 * `search_mcp_tools` result block and map each back to its raw MCP
 * `toolName` via the current eval defs. Returns toolNames in the order
 * the block listed them (BM25 rank order). Unknown jsNames are dropped.
 */
function parseReturnedToolNames(resultBlock: string): string[] {
  const defs = getEvalMcpDefs();
  const byJsName = new Map(defs.map((d) => [d.jsName, d.toolName]));
  const names: string[] = [];
  const re = /declare function (\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(resultBlock)) !== null) {
    const toolName = byJsName.get(m[1]);
    if (toolName) names.push(toolName);
  }
  return names;
}

/**
 * Build the AI-SDK `Tool` for `search_mcp_tools` the model sees in search
 * mode. Reuses the production tool's `execute` (real BM25 ranking over
 * `ctx.mcpToolDefs`) and `inputSchema`/`description`, wrapping `execute`
 * to record one `SearchCallRecord` per call.
 */
export function buildSearchMcpToolsHarnessTool(params: {
  state: McpRunState;
  ctx: AgentContext;
}): Tool {
  return {
    description: searchMcpToolsTool.description,
    inputSchema: searchMcpToolsTool.inputSchema,
    execute: async (args: { query: string; server?: string }) => {
      const index = params.state.searchCalls.length;
      const startedAt = Date.now();
      const result = await searchMcpToolsTool.execute(args, params.ctx);
      const returnedToolNames = parseReturnedToolNames(result);
      const durationMs = Date.now() - startedAt;
      params.state.searchCalls.push({
        timestamp: new Date().toISOString(),
        index,
        query: args.query,
        server: args.server ?? null,
        returnedToolNames,
        durationMs,
      });
      notifyEvalSearchCall({
        query: args.query,
        server: args.server,
        returnedToolNames,
        durationMs,
      });
      return result;
    },
  };
}
