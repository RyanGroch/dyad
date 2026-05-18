// MCP eval cases. Each case asks the model to accomplish a real task by
// calling MCP tools from inside `execute_sandbox_script`. Verdicts come
// from a combination of:
//   - structural checks: required MCP tool names appeared, ordering ok,
//     consent denials handled gracefully
//   - judge: LLM-as-judge against the final assistant text + recorded
//     MCP transcript
//
// Cases reference `{ORIGIN}` — the harness substitutes the fixture
// server's origin (e.g. `http://127.0.0.1:54321`) before sending the
// prompt to the model.

export interface McpEvalCase {
  name: string;
  /**
   * User prompt. `{ORIGIN}` is replaced with the fixture server origin
   * at runtime.
   */
  prompt: string;
  /**
   * Substrings the harness expects to find in the recorded MCP tool
   * names (jsName form). Each entry must match at least one recorded
   * call. Used as a coarse "did the model attempt the right kind of
   * call" check before falling through to the judge.
   */
  expectedToolNameContains?: string[];
  /**
   * Substrings the harness expects to find in the final assistant text.
   * Case-sensitive. Empty array means "judge decides on its own".
   */
  expectedAnswerContains?: string[];
  /**
   * If true, the harness installs a consent decliner for the first MCP
   * call. Used by the "consent denied" case to verify graceful
   * recovery.
   */
  denyFirstConsent?: boolean;
  /**
   * If true, the case expects the model to NOT invoke any MCP tool
   * (negative case — the prompt is answerable without one).
   */
  expectNoMcpCalls?: boolean;
}

export const MCP_CASES: McpEvalCase[] = [
  {
    name: "Single call: read page title",
    prompt:
      "Open {ORIGIN}/ in the browser and tell me the exact text of the page's <h1> element.",
    expectedToolNameContains: [
      "navigate_page|new_page",
      "snapshot|evaluate_script",
    ],
    expectedAnswerContains: ["Welcome to the MCP Eval Fixture"],
  },
  {
    name: "Chain with data dependency: follow first nav link",
    prompt:
      "Open {ORIGIN}/, find the first link in the navigation list, follow it, and report the page's title.",
    expectedToolNameContains: ["navigate_page|new_page"],
    expectedAnswerContains: ["Products"],
  },
  {
    name: "Loop and aggregate: sum product prices",
    prompt:
      "Open {ORIGIN}/products. Read every row in the products table and report the total price (sum) of all three products, formatted as a dollar amount with cents.",
    expectedToolNameContains: [
      "navigate_page|new_page",
      "snapshot|evaluate_script",
    ],
    expectedAnswerContains: ["$42.25"],
  },
  {
    name: "Filter and return: cheapest product",
    prompt:
      "Open {ORIGIN}/products and tell me only the SKU of the cheapest product. Do not include any other product information.",
    expectedToolNameContains: [
      "navigate_page|new_page",
      "snapshot|evaluate_script",
    ],
    expectedAnswerContains: ["SKU-003"],
  },
  {
    name: "Mixed file + MCP: read instructions then navigate",
    prompt:
      // The harness writes an `instructions.txt` to the app dir with the
      // single line `visit /about` before this case runs. The model must
      // read the file via the sandbox `read_file` host call and then
      // navigate accordingly.
      "Read the file `instructions.txt` in this app, follow whatever single instruction it contains using the {ORIGIN} server, and then report the value of the page element with id `build-id`.",
    expectedToolNameContains: ["navigate_page|new_page"],
    expectedAnswerContains: ["eval-fixture-2026.05"],
  },
  {
    name: "Error handling: invalid URL",
    prompt:
      "Try to open {ORIGIN}/this-page-does-not-exist. If the page returns a 404 or error, do NOT retry indefinitely — report what happened and stop.",
    expectedToolNameContains: ["navigate_page|new_page"],
    expectedAnswerContains: ["404|Not found|not found"],
  },
  {
    name: "Consent denied: graceful failure",
    prompt:
      "Use the chrome devtools browser tools to open {ORIGIN}/orders. " +
      "If your first browser tool call is denied due to user permissions, " +
      "retry the same call once — the second attempt will be allowed. " +
      "Then read the open-order count from the page and report it.",
    denyFirstConsent: true,
    expectedToolNameContains: ["navigate_page|new_page"],
    expectedAnswerContains: ["3"],
  },
  {
    name: "Negative case: answer without MCP",
    prompt:
      "What is 17 multiplied by 24? Answer the math question directly — do not open any pages or call any tools.",
    expectNoMcpCalls: true,
    expectedAnswerContains: ["408"],
  },
];
