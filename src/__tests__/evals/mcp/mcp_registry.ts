import type { McpToolDef } from "@/pro/main/ipc/handlers/local_agent/tools/mcp_type_defs";

// Module-level mutable registry shared between the eval runner and the
// vitest `vi.mock(...)` factories in `tool_use.eval.ts`. Lives in its
// own module so the factories can import a stable handle without
// participating in the mock graph.

type ConsentDecider = (params: {
  serverId: number;
  toolName: string;
  callIndex: number;
}) => boolean | Promise<boolean>;

export interface McpCallObserverEvent {
  jsName: string;
  serverName: string;
  toolName: string;
  args: unknown;
  result: unknown | null;
  durationMs: number;
  succeeded: boolean;
  error: string | null;
  // Deep-serialized error (see `helpers/eval_recorder.ts`). Only set
  // when `succeeded: false`. Lets the recorder persist the full
  // JSON-RPC cause chain — `error` (= `err.message`) is often too
  // terse for debugging.
  errorDetail?: unknown;
}

interface RegistryState {
  defs: McpToolDef[];
  consentDecider: ConsentDecider;
  consentCallCount: number;
  /**
   * Per-call observer invoked from the mocked consent module so the
   * harness can record an `McpCallRecord` even when consent is denied.
   */
  onConsentDecision?: (params: {
    serverId: number;
    serverName: string;
    toolName: string;
    callIndex: number;
    granted: boolean;
  }) => void;
  /**
   * Invoked from the wrapped capability map after each MCP tool call
   * finishes (success or error). Used by the harness to populate
   * `McpRunState.mcpCalls`.
   */
  onMcpCall?: (event: McpCallObserverEvent) => void;
}

const state: RegistryState = {
  defs: [],
  consentDecider: () => true,
  consentCallCount: 0,
};

export function setEvalMcpDefs(defs: McpToolDef[]): void {
  state.defs = defs;
}

export function getEvalMcpDefs(): McpToolDef[] {
  return state.defs;
}

export function setEvalConsentDecider(decider: ConsentDecider): void {
  state.consentDecider = decider;
  state.consentCallCount = 0;
}

export function resetEvalConsentDecider(): void {
  state.consentDecider = () => true;
  state.consentCallCount = 0;
}

export function setEvalConsentObserver(
  observer: RegistryState["onConsentDecision"],
): void {
  state.onConsentDecision = observer;
}

export function setEvalMcpCallObserver(
  observer: RegistryState["onMcpCall"],
): void {
  state.onMcpCall = observer;
}

export function notifyEvalMcpCall(event: McpCallObserverEvent): void {
  state.onMcpCall?.(event);
}

/**
 * Deep-serialize an error into a plain object: own properties
 * (including non-enumerable like `message`/`stack`), any custom fields
 * the throwing library attached (`code`, `data`, …), and the recursive
 * `.cause` chain. AI SDK / MCP SDK wrap JSON-RPC errors and the most
 * useful information ("did not contain a required property of
 * 'question'") often lives in `.cause` or a custom field, not in
 * `err.message`. Capping `depth` keeps a pathological cause-cycle from
 * blowing the call stack.
 */
export function serializeError(err: unknown, depth = 0): unknown {
  if (depth > 5) return "[truncated: cause chain too deep]";
  if (err === null || err === undefined) return err;
  if (!(err instanceof Error)) {
    if (typeof err === "object") {
      try {
        return JSON.parse(JSON.stringify(err));
      } catch {
        return String(err);
      }
    }
    return err;
  }
  const out: Record<string, unknown> = {
    name: err.name,
    message: err.message,
    stack: err.stack,
  };
  for (const key of Object.getOwnPropertyNames(err)) {
    if (key in out || key === "cause") continue;
    out[key] = (err as unknown as Record<string, unknown>)[key];
  }
  const cause = (err as unknown as { cause?: unknown }).cause;
  if (cause !== undefined) {
    out.cause = serializeError(cause, depth + 1);
  }
  return out;
}

/**
 * Called by the mocked `requireMcpToolConsent`. Increments the call
 * counter, invokes the registered decider, and notifies the observer.
 */
export async function evalConsentDecide(params: {
  serverId: number;
  serverName: string;
  toolName: string;
}): Promise<boolean> {
  const callIndex = state.consentCallCount++;
  const granted = await state.consentDecider({
    serverId: params.serverId,
    toolName: params.toolName,
    callIndex,
  });
  state.onConsentDecision?.({
    serverId: params.serverId,
    serverName: params.serverName,
    toolName: params.toolName,
    callIndex,
    granted,
  });
  return granted;
}
