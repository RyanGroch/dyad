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
export type McpServerKey =
  | "chrome_devtools"
  | "stripe"
  | "linear"
  | "filesystem"
  | "memory"
  | "everything";

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

// Linear cases stay read-only so they pass against any workspace the
// user grants the OAuth app `read` access to, even an empty one. Tool
// expectations use substrings of the sanitized jsName
// (`linear_eval__<tool_name>`); Linear's MCP currently exposes tools
// like `list_issues`, `list_teams`, `list_projects`, `get_user`,
// `search_issues`, etc. — substrings chosen to match the family rather
// than a specific name.
const LINEAR_CASES: McpEvalCase[] = [
  {
    name: "List teams in workspace",
    server: "linear",
    prompt:
      "Use the Linear MCP tools to list the teams in this Linear workspace. " +
      "Report how many teams were returned. If zero, say `0 teams`. Otherwise " +
      "state the count plainly. You do not need to list the team names.",
    expectedToolNameContains: ["team"],
    expectedAnswerContains: ["team"],
  },
  {
    name: "Identify authenticated user",
    server: "linear",
    prompt:
      "Use the Linear MCP tools to look up the currently authenticated user " +
      "for this OAuth token. Report the user's display name or email — " +
      "whichever the API returns.",
    expectedToolNameContains: ["user|me|viewer"],
    expectedAnswerContains: ["@|name"],
  },
  {
    name: "Consent denied then retry: list teams",
    server: "linear",
    prompt:
      "Use the Linear MCP tools to list teams in this workspace. If your " +
      "first Linear tool call is denied due to user permissions, retry the " +
      "same call once — the second attempt will be allowed. Then report how " +
      "many teams were returned.",
    denyFirstConsent: true,
    expectedToolNameContains: ["team"],
    expectedAnswerContains: ["team"],
  },
];

export const MCP_CASES: McpEvalCase[] = [
  ...CHROME_DEVTOOLS_CASES,
  ...STRIPE_CASES,
  ...LINEAR_CASES,
];

// ── mcp_search suite (tool discovery via search) ─────────────────
//
// These cases run in search mode: the model is NOT shown MCP tool
// declarations up front. It must call `search_mcp_tools` (BM25 today) to
// find a tool that does the job, then call it from `execute_sandbox_script`.
//
// This is a RETRIEVAL eval. It measures whether the search algorithm
// surfaces a tool that accomplishes the task given how the model phrases its
// query — NOT whether the model follows tricky instructions. So a case
// lists every tool that genuinely satisfies the task in `acceptableToolNames`
// (pass = the model surfaced and called any one of them); there is no
// blocklist. The discriminating cases are vocabulary-gap ones where the
// prompt's wording does not lexically match the tool's name/description —
// that is where a lexical algorithm like BM25 is stressed and where a
// semantic ranker would differ.
//
// The catalog is the union of the servers spawned for the suite. A case is
// SKIPPED (not failed) when none of its `acceptableToolNames` are present in
// the spawned catalog, so an un-spawned server (e.g. GitHub before it is
// wired) or a tool renamed by a version bump degrades cleanly.
export interface McpSearchCase {
  name: string;
  /**
   * User prompt phrased in intent terms (ideally NOT echoing the tool's
   * name), describing a task that at least one catalog tool accomplishes.
   */
  prompt: string;
  /**
   * Raw MCP `toolName`(s) that genuinely accomplish the task. The model
   * passes if it surfaces one of these via search AND calls it. Matched
   * exactly against recorded `toolName`s. Include every tool that does the
   * job — do not over-constrain.
   */
  acceptableToolNames: string[];
  /**
   * Canonical queries a reasonable model might issue for this task, fed
   * directly to the ranker by the model-independent BM25 benchmark
   * (`mcp_search_bm25`) to measure the algorithm in isolation. Each query
   * should surface an acceptable tool in the top results. Omit to skip the
   * algorithm benchmark for this case.
   */
  goldQueries?: string[];
  /**
   * Ground truth handed to the judge (what accomplishes the task), so
   * cosmetic answer phrasing doesn't flip the verdict.
   */
  groundTruth?: string;
}

// Memory-server cases run with no credentials today. GitHub cases are the
// richer set but stay SKIPPED until the GitHub server is wired and added to
// the catalog (run them then via EVAL_MCP_SEARCH_SERVERS=github,...). Tool
// names are the pinned servers' real names; a mismatch degrades to SKIP.
const MEMORY_SEARCH_CASES: McpSearchCase[] = [
  {
    name: "memory: find stored notes about a topic",
    prompt:
      "Find anything you have stored in memory related to 'database " +
      "migrations' and report what you find. If there is nothing, say so.",
    acceptableToolNames: ["search_nodes"],
    goldQueries: [
      "find stored entities about a topic",
      "search memory for notes",
      "query knowledge graph by keyword",
    ],
    groundTruth:
      "`search_nodes` queries the knowledge graph by keyword, which is what " +
      "finding stored items about a topic requires.",
  },
  {
    name: "memory: save a note about the user",
    prompt:
      "Remember, for later, that the user prefers TypeScript over " +
      "JavaScript. Store this so it can be recalled in a future session.",
    acceptableToolNames: ["create_entities", "add_observations"],
    goldQueries: [
      "save a note to remember later",
      "store a fact about the user",
      "add information to memory",
    ],
    groundTruth:
      "Storing a new fact is done with `create_entities` (new entity) or " +
      "`add_observations` (attach to an existing one); either accomplishes " +
      "saving the preference.",
  },
  {
    name: "memory: dump everything stored",
    prompt:
      "Show me everything currently stored in your memory — the full " +
      "contents of the knowledge graph.",
    acceptableToolNames: ["read_graph"],
    goldQueries: [
      "show everything in memory",
      "read the entire knowledge graph",
      "dump all stored data",
    ],
    groundTruth:
      "`read_graph` returns the entire knowledge graph, which is what " +
      "'everything stored' asks for.",
  },
];

// GitHub cases (skipped until the GitHub server is in the catalog). Ordered
// roughly by retrieval difficulty: lexical baselines, then vocabulary-gap
// cases (prompt wording != tool wording), then dense-cluster discrimination,
// then multi-acceptable.
const GITHUB_SEARCH_CASES: McpSearchCase[] = [
  // Baseline: prompt words match the tool directly.
  {
    name: "github: find repositories about a topic",
    prompt:
      "Find popular GitHub repositories about WebAssembly runtimes and list " +
      "a few of them.",
    acceptableToolNames: ["search_repositories"],
    goldQueries: ["search repositories", "find github repos by topic"],
    groundTruth: "`search_repositories` finds repos by name/description/topic.",
  },
  {
    name: "github: search code across repositories",
    prompt:
      "Search GitHub for code that imports the tensorflow library and show " +
      "a few matches.",
    acceptableToolNames: ["search_code"],
    goldQueries: ["search code", "find code matching a pattern on github"],
    groundTruth: "`search_code` searches code across GitHub repositories.",
  },
  // Vocabulary gap: intent words differ from the tool's name.
  {
    name: "github: who am I (authenticated user)",
    prompt:
      "Who am I logged in as on GitHub? Report my username and profile " +
      "details.",
    acceptableToolNames: ["get_me"],
    goldQueries: [
      "who am I",
      "current authenticated user profile",
      "my github account details",
    ],
    groundTruth:
      "`get_me` returns the authenticated user's profile — i.e. who you are " +
      "logged in as.",
  },
  {
    name: "github: open a new issue (tool named issue_write)",
    prompt:
      "Open a new issue in the repository owner/repo titled 'Flaky test' " +
      "describing an intermittently failing test.",
    acceptableToolNames: ["issue_write"],
    goldQueries: ["create a new issue", "open a github issue", "file an issue"],
    groundTruth:
      "`issue_write` creates (or updates) an issue. Its name lacks " +
      "'create'/'open', so the model must rely on the description to find it.",
  },
  {
    name: "github: most recent release",
    prompt:
      "What is the most recent released version of the repository " +
      "owner/repo?",
    acceptableToolNames: ["get_latest_release"],
    goldQueries: [
      "latest release",
      "newest released version",
      "most recent release of a repo",
    ],
    groundTruth: "`get_latest_release` returns the latest release of a repo.",
  },
  {
    name: "github: commit history of a branch",
    prompt:
      "Show me the commit history of the main branch in the repository " +
      "owner/repo.",
    acceptableToolNames: ["list_commits"],
    goldQueries: ["commit history", "list commits on a branch"],
    groundTruth: "`list_commits` returns the commits of a branch.",
  },
  {
    name: "github: read a file's contents",
    prompt:
      "Get the contents of the README.md file in the repository owner/repo " +
      "and summarize it.",
    acceptableToolNames: ["get_file_contents"],
    goldQueries: ["read a file from a repo", "get file contents"],
    groundTruth:
      "`get_file_contents` returns the contents of a file in a repository.",
  },
  {
    name: "github: sync a PR branch with its base",
    prompt:
      "Bring pull request #42 in owner/repo up to date by merging the latest " +
      "changes from its base branch into it.",
    acceptableToolNames: ["update_pull_request_branch"],
    goldQueries: [
      "update pull request branch with base",
      "sync PR branch with the latest base changes",
    ],
    groundTruth:
      "`update_pull_request_branch` updates a PR's branch with the latest " +
      "changes from the base branch (distinct from `update_pull_request`, " +
      "which edits PR metadata).",
  },
  // Dense-cluster discrimination: many list_* tools share the verb.
  {
    name: "github: list tags",
    prompt: "List the git tags in the repository owner/repo.",
    acceptableToolNames: ["list_tags"],
    goldQueries: ["list tags", "git tags in a repository"],
    groundTruth: "`list_tags` lists a repository's git tags.",
  },
  {
    name: "github: list branches",
    prompt: "List the branches in the repository owner/repo.",
    acceptableToolNames: ["list_branches"],
    goldQueries: ["list branches", "branches in a repository"],
    groundTruth: "`list_branches` lists a repository's branches.",
  },
  // Multiple acceptable answers: don't over-constrain.
  {
    name: "github: find issues mentioning a phrase",
    prompt:
      "Find issues in the repository owner/repo that mention 'memory leak'.",
    acceptableToolNames: ["search_issues", "list_issues"],
    goldQueries: ["search issues for a phrase", "find issues mentioning text"],
    groundTruth:
      "Either `search_issues` (issue search syntax) or `list_issues` " +
      "(enumerate then filter) can satisfy finding issues mentioning a phrase.",
  },
];

export const MCP_SEARCH_CASES: McpSearchCase[] = [
  ...MEMORY_SEARCH_CASES,
  ...GITHUB_SEARCH_CASES,
];
