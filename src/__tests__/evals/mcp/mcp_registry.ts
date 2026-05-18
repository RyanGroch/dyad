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
