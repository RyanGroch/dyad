// MCP eval cases. Each case asks the model to accomplish a real task by
// calling MCP tools from inside `execute_sandbox_script`. Verdicts come
// from a combination of:
//   - structural checks: required MCP tool names appeared, ordering ok,
//     consent denials handled gracefully
//   - judge: LLM-as-judge against the final assistant text + recorded
//     MCP transcript
//
// Cases are tagged with `server` to select which MCP server the runner
// spawns for the case (see `mcp/servers/`). Cases referencing `{ORIGIN}`
// are valid only on servers whose spec declares `needsFixtureServer:
// true` — the harness substitutes the fixture server's origin (e.g.
// `http://127.0.0.1:54321`) before sending the prompt to the model.

/**
 * Identifier of an MCP server spec registered in `mcp/servers/index.ts`.
 * Wider than `string` would be (we keep server-name strings cheap to
 * add) but narrower than `string` (so a typo'd `server: "chrom"` fails
 * fast at runtime when the registry lookup misses).
 */
export type McpServerKey = "chrome_devtools" | "stripe";

export interface McpEvalCase {
  name: string;
  /**
   * Which MCP server spec this case wants spawned. Determines tool
   * availability and whether `{ORIGIN}` substitution is meaningful.
   */
  server: McpServerKey;
  /**
   * User prompt. `{ORIGIN}` is replaced with the fixture server origin
   * at runtime — only meaningful for cases whose `server` spec
   * declares `needsFixtureServer: true`.
   */
  prompt: string;
  /**
   * Substrings the harness expects to find in the recorded MCP tool
   * names (jsName form). Each entry must match at least one recorded
   * call. Entries support `|`-alternation so synonymous tool names
   * count as one match (e.g. `"navigate_page|new_page"`). Used as a
   * coarse "did the model attempt the right kind of call" check before
   * falling through to the judge.
   */
  expectedToolNameContains?: string[];
  /**
   * Substrings the harness expects to find in the final assistant text
   * (case-insensitive). Empty array means "judge decides on its own".
   * Entries support `|`-alternation.
   */
  expectedAnswerContains?: string[];
  /**
   * If true, the harness installs a consent decliner for the first MCP
   * call. Used by consent-denied cases to verify graceful recovery.
   */
  denyFirstConsent?: boolean;
  /**
   * If true, the case expects the model to NOT invoke any MCP tool
   * (negative case — the prompt is answerable without one).
   */
  expectNoMcpCalls?: boolean;
  /**
   * Optional file to write into the per-case temp app dir before the
   * model runs. Used by cases that exercise file host calls
   * (`read_file`, etc.) inside `execute_sandbox_script`. Keeps the
   * runner out of the business of mapping case names to fixtures.
   */
  setupFile?: { name: string; contents: string };
}

const CHROME_DEVTOOLS_CASES: McpEvalCase[] = [
  {
    name: "Single call: read page title",
    server: "chrome_devtools",
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
    server: "chrome_devtools",
    prompt:
      "Open {ORIGIN}/, find the first link in the navigation list, follow it, and report the page's title.",
    expectedToolNameContains: ["navigate_page|new_page"],
    expectedAnswerContains: ["Products"],
  },
  {
    name: "Loop and aggregate: sum product prices",
    server: "chrome_devtools",
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
    server: "chrome_devtools",
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
    server: "chrome_devtools",
    prompt:
      // The case's setupFile writes `instructions.txt` to the app dir
      // with the single line `visit /about` before this case runs. The
      // model must read the file via the sandbox `read_file` host call
      // and then navigate accordingly.
      "Read the file `instructions.txt` in this app, follow whatever single instruction it contains using the {ORIGIN} server, and then report the value of the page element with id `build-id`.",
    expectedToolNameContains: ["navigate_page|new_page"],
    expectedAnswerContains: ["eval-fixture-2026.05"],
    setupFile: { name: "instructions.txt", contents: "visit /about\n" },
  },
  {
    name: "Error handling: invalid URL",
    server: "chrome_devtools",
    prompt:
      "Try to open {ORIGIN}/this-page-does-not-exist. If the page returns a 404 or error, do NOT retry indefinitely — report what happened and stop.",
    expectedToolNameContains: ["navigate_page|new_page"],
    expectedAnswerContains: ["404|Not found|not found"],
  },
  {
    name: "Consent denied: graceful failure",
    server: "chrome_devtools",
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
    server: "chrome_devtools",
    prompt:
      "What is 17 multiplied by 24? Answer the math question directly — do not open any pages or call any tools.",
    expectNoMcpCalls: true,
    expectedAnswerContains: ["408"],
  },
];

// Stripe cases lean on read-only / documentation-search tools so a
// `sk_test_...` API key against a fresh test account is enough to make
// them pass. Avoid cases that depend on pre-seeded customers, products,
// or balances — different test accounts will have different state.
//
// Tool name expectations use `|`-alternation against substrings of the
// sanitized jsName, which is `stripe_eval__<tool_name>`. Across Stripe
// MCP server versions tool names have shifted between dotted (e.g.
// `customers.list`) and snake_case (e.g. `list_customers`) — the
// substrings below are chosen to match both shapes.
const STRIPE_CASES: McpEvalCase[] = [
  {
    name: "Search docs: webhook signature header",
    server: "stripe",
    prompt:
      "Use the Stripe MCP tools to search the Stripe documentation for how Stripe " +
      "signs webhook payloads. Report the exact name of the HTTP header that " +
      "carries the webhook signature.",
    expectedToolNameContains: ["documentation|docs|search"],
    expectedAnswerContains: ["Stripe-Signature"],
  },
  {
    name: "Search docs: successful test card number",
    server: "stripe",
    prompt:
      "Use the Stripe MCP tools to search the Stripe documentation for the test " +
      "card numbers Stripe provides for simulating a successful payment. Report " +
      "at least one test card number that produces a successful charge.",
    expectedToolNameContains: ["documentation|docs|search"],
    expectedAnswerContains: ["4242 4242 4242 4242|4242424242424242"],
  },
  {
    name: "Retrieve account balance",
    server: "stripe",
    prompt:
      "Use the Stripe MCP tools to retrieve the Stripe account's current balance. " +
      "Report the available balance in USD, formatted as a dollar amount with " +
      "cents (e.g. `$0.00` or `$123.45`).",
    expectedToolNameContains: ["balance"],
    expectedAnswerContains: ["$"],
  },
  {
    name: "List customers and report count",
    server: "stripe",
    prompt:
      "Use the Stripe MCP tools to list customers on this Stripe account (limit " +
      "10 if the tool supports a limit). Report exactly how many customers were " +
      "returned. If zero, say `0 customers`. Otherwise state the count plainly.",
    expectedToolNameContains: ["customer"],
    expectedAnswerContains: ["customer"],
  },
  {
    name: "Consent denied then retry: balance",
    server: "stripe",
    prompt:
      "Use the Stripe MCP tools to retrieve the account balance. If your first " +
      "Stripe tool call is denied due to user permissions, retry the same call " +
      "once — the second attempt will be allowed. Then report the available " +
      "balance in USD, formatted as a dollar amount.",
    denyFirstConsent: true,
    expectedToolNameContains: ["balance"],
    expectedAnswerContains: ["$"],
  },
];

export const MCP_CASES: McpEvalCase[] = [
  ...CHROME_DEVTOOLS_CASES,
  ...STRIPE_CASES,
];
