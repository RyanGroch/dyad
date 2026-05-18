# Evals

LLM eval suite for tool-use quality. Several file-edit suites run the same
cases against several frontier models, but with different tool sets and
system prompts. The active list lives in `tool_use.eval.ts` (`SUITES`,
`ALL_MODELS`, `CASES`) — that file is the source of truth; this README
explains the framework, not the specific contents.

| Suite name               | Tools available                | System prompt                                |
| ------------------------ | ------------------------------ | -------------------------------------------- |
| `search_replace`         | `search_replace` only          | Minimal custom "precise code editor" prompt  |
| `search_replace_few`     | `search_replace` only          | Variant prompt encouraging fewer tool calls  |
| `basic_agent`            | `search_replace`, `write_file` | Production `LOCAL_AGENT_BASIC_SYSTEM_PROMPT` |
| `pro_agent`              | `search_replace`, `write_file` | Production `LOCAL_AGENT_SYSTEM_PROMPT` (Pro) |
| `pro_agent_experimental` | `search_replace`, `write_file` | Editable copy of the Pro prompt for tweaking |

A sixth suite, `mcp_execute`, has a different case shape — see the **MCP
eval suite** section near the end of this README.

Each case gives the model a real source file plus an editing instruction,
runs the model with the suite's tools wired up, applies the produced edits,
and then asks an LLM judge (defined as `JUDGE_MODEL` in
`tool_use.eval.ts`) whether the result satisfies the instruction.

## Prerequisites

All models are routed through the Dyad Engine gateway, so you only need one
credential: a Dyad Pro API key, exposed as `DYAD_PRO_API_KEY`.

The suite is skipped entirely when `DYAD_PRO_API_KEY` is unset — no tests will
fail, they just won't run. This keeps regular `vitest run` safe for contributors
without a key.

Export the key for the session (plus the two required filter vars — see
[Running the suite](#running-the-suite)):

```bash
export DYAD_PRO_API_KEY="..."
EVAL_SUITE=all EVAL_MODEL=all npm run eval
```

Or set everything inline for a single command:

```bash
DYAD_PRO_API_KEY="..." EVAL_SUITE=all EVAL_MODEL=all npm run eval
```

Optional: override the gateway URL with `DYAD_ENGINE_URL` (defaults to
`https://engine.dyad.sh/v1`).

## Running the suite

**Both `EVAL_SUITE` and `EVAL_MODEL` are required.** A full run of every
suite against every model is expensive, so the suite will not run unless
the caller opts in explicitly. If either variable is unset, the eval prints
a warning describing how to configure it and registers a single skipped
placeholder — it does not fail CI, but it also does not run any cases.

Use the special value `all` to mean "run everything":

```bash
# Run every suite against every model against every case.
EVAL_SUITE=all EVAL_MODEL=all DYAD_PRO_API_KEY="..." npm run eval
```

**Heads up — this is expensive.** A full `all`/`all` run issues one
generation per (suite × model × case) triple plus one judge call per case.
Expect dozens to hundreds of LLM requests, some of which run reasoning
models on 300+ line fixtures. Use sparingly; prefer narrow filters during
development.

### Running a single suite

Set `EVAL_SUITE` to the exact `name` (case-insensitive) of the suite — the
same name that appears as a folder under `eval-results/`. A comma-separated
list runs multiple suites:

```bash
# Just the original search_replace-only suite
EVAL_SUITE=search_replace EVAL_MODEL=all DYAD_PRO_API_KEY="..." npm run eval

# The basic_agent suite (Basic agent prompt, search_replace + write_file)
EVAL_SUITE=basic_agent EVAL_MODEL=all DYAD_PRO_API_KEY="..." npm run eval

# The pro_agent suite (Pro agent prompt, search_replace + write_file)
EVAL_SUITE=pro_agent EVAL_MODEL=all DYAD_PRO_API_KEY="..." npm run eval
```

Note: `EVAL_SUITE` matches suite `name`s exactly (case-insensitive), and
accepts a comma-separated list for multiple suites (e.g.
`EVAL_SUITE=search_replace,basic_agent`). Unknown names error out with the
available list.

### Running a single case

Vitest's `-t` flag filters by test name. Case names are the `name` field in
the `CASES` array of [tool_use.eval.ts](tool_use.eval.ts).

```bash
EVAL_SUITE=all EVAL_MODEL=all DYAD_PRO_API_KEY="..." \
  npm run eval -- -t "Extract a helper function"
```

`-t` matches as a substring, so a short unique fragment works too:

```bash
EVAL_SUITE=all EVAL_MODEL=all DYAD_PRO_API_KEY="..." npm run eval -- -t "zod"
```

### Running against one model

Set `EVAL_MODEL` to a case-insensitive substring of the model's label or
model name. It matches against both, so short fragments like `sonnet`, `gpt`,
or `gemini` work:

```bash
EVAL_SUITE=all EVAL_MODEL=sonnet DYAD_PRO_API_KEY="..." npm run eval
```

### Combining filters

`EVAL_SUITE`, `EVAL_MODEL`, and `-t` compose. A tight development loop:

```bash
EVAL_SUITE=search_replace EVAL_MODEL=sonnet \
  DYAD_PRO_API_KEY="..." npm run eval -- -t "Extract a helper function"
```

Note: vitest's `-t` pattern is applied across the full describe/test
hierarchy as a regex, which makes "model label > case name" style patterns
brittle across vitest versions. Prefer `EVAL_SUITE` / `EVAL_MODEL` for
suite and model filtering and reserve `-t` for case-name filtering.

## Where results are stored

Every run writes structured output to `eval-results/` at the repo root. The
directory is gitignored and never cleaned automatically — delete old runs by
hand when you want to.

Layout:

```
eval-results/
  <suite-name>/                          ← one top-level folder per suite
    <run-start-ts>__<model-label>/       ← one folder per (run, model)
      <case-name>/                       ← one folder per case
        record.json                      ← full structured record
        record.txt                       ← human-readable render of the same
        details/                         ← per-record split views
          file_before.<ext>              ← file at the start of the run
          file_after.<ext>               ← file at the end of the run
          diff.patch                     ← cumulative unified diff
          system_prompt.txt              ← system prompt sent to the model
          instructions.txt               ← case instructions (no file content)
          user_prompt.txt                ← full user message (file + instructions)
          metadata.json                  ← run metadata without big blobs
          metadata.txt                   ← same info, human-readable
        tool_calls/
          01.txt                         ← combined view of tool call #1
          01/                            ← split view, one piece per file
            file_before.<ext>
            file_after.<ext>
            diff.patch
            meta.txt
            <arg_name>.<ext>             ← one file per tool arg (see below)
          02.txt
          02/
          ...
```

The top-level folder is the suite `name`, so each suite lands in its own
directory under `eval-results/`. Browse the directory after a run to see
which suites have results.

`<run-start-ts>` is captured once at process start, so every case from the
same `npm run eval` invocation for a given (suite, model) pair clusters into
one folder. Folder names sort chronologically under `ls`.

### Record format

`record.json` contains the complete machine-readable record. Key fields:

- `timestamp`, `suite`, `caseName` — identifying metadata.
- `model` — `{label, provider, modelName, responseModelId}`. `responseModelId`
  is the exact model string the gateway echoed back, which can differ from
  `modelName` (e.g. dated snapshots).
- `prompt` — `{system, instructions, user}`. `system` is the full system
  prompt sent to the model (including the production agent prompts when the
  suite uses one). `instructions` is the bare case instruction — useful for
  scanning what was asked without the fixture file inlined. `user` is the
  full user message actually sent (file content + instructions).
- `file` — `{name, before, after}`. The fixture file name plus its content
  at the start and end of the run. `before` / `after` are also written to
  `details/file_before.<ext>` / `details/file_after.<ext>` for easy editor
  opening with matching syntax highlighting.
- `llm.totalDurationMs`, `llm.totalUsage` — wall-clock time and token totals
  for the model under test (not the judge).
- `llm.requests` — per-step breakdown: each entry is one HTTP round-trip with
  its own duration, usage, and `finishReason`.
- `toolCalls` — every tool call the model made. Each entry records
  `toolName`, `filePath`, an `args` map (keyed by the tool's parameter names,
  so `old_string`/`new_string` for `search_replace`, `content` for
  `write_file`), the file before and after the call, and a unified diff of
  just that call.
- `diff` — unified diff from the original fixture to the final file
  (i.e. the cumulative effect of all tool calls).
- `judge` — the judge's verdict: `label`, `modelName`, `durationMs`,
  `usage`, `pass` (boolean), and `explanation` (the judge's written
  reasoning, with the trailing `PASS`/`FAIL` verdict line stripped).
- `passed` — the overall test outcome. Requires the judge to say `PASS` _and_
  all structural checks to pass _and_ no exceptions to be thrown.
- `errorMessage` — set when the test threw (tool-call failure, structural
  check failure, judge FAIL, etc.); `null` otherwise.

`record.txt` is a readable render of the same information — headers, the
system prompt and instructions, inline tool-call bodies, usage totals, the
final diff, and the judge's explanation. Open it when you want a quick
human-readable summary instead of parsing JSON.

### The `details/` folder

`details/` is a split view of the record, intended for quick inspection and
diffing without having to parse JSON or scroll through `record.txt`:

- `file_before.<ext>` / `file_after.<ext>` — raw file content before and
  after the run, with the fixture's extension preserved so editors apply
  the right syntax highlighting.
- `diff.patch` — the same unified diff as `record.diff`.
- `system_prompt.txt`, `instructions.txt`, `user_prompt.txt` — the three
  views of the prompt input.
- `metadata.json` / `metadata.txt` — everything from `record.json` minus the
  large content blobs that already have their own files (no inline file
  contents and no per-tool-call entries). Useful for skimming token counts,
  judge verdict, and model identity across many runs.

### The `tool_calls/` folder

One `NN.txt` (combined view) and one `NN/` folder (split view) per tool
call. The split view contains the raw pieces as standalone files:

- `file_before.<ext>`, `file_after.<ext>`, `diff.patch` — file state around
  the single call.
- `meta.txt` — timestamp, tool name, target path, and per-arg length summary.
- One file per tool argument, named after the arg's key. String args use the
  target file's extension (for syntax highlighting); non-string args become
  JSON blobs. So a `search_replace` call produces `old_string.ts` and
  `new_string.ts`; a `write_file` call produces `content.ts` and
  `description.ts`.

## MCP eval suite (`mcp_execute`)

The `mcp_execute` suite exercises the model's ability to call **MCP
tools** from inside the production `execute_sandbox_script` tool. Unlike
the file-edit suites, cases here do not edit a fixture file — they pose a
question whose answer requires the model to drive an MCP server (browse
a web page, query a remote API, search documentation, …), and the
verdict is the model's final assistant text.

The suite supports multiple MCP servers, one spec per server under
`mcp/servers/`. Each case is tagged with a `server` key and routed to
that server's spec by the runner. Select which servers run via
`EVAL_MCP_SERVERS` (default `chrome_devtools`). The authoritative list
of available server keys is `MCP_SERVER_SPECS` in
`mcp/servers/index.ts`.

### How it works

- For each active server spec, a sub-describe spawns its own MCP server
  in `beforeAll`, registers the live client with `mcpManager`, and
  records the discovered tool defs.
- Specs that declare `needsFixtureServer: true` (i.e. `chrome_devtools`)
  also start a small Node HTTP server on `127.0.0.1:<random>` serving
  deterministic HTML pages from `mcp/fixture_pages.ts`. Cases for those
  specs reference the server origin via the `{ORIGIN}` placeholder in
  their prompt. Other specs (e.g. `stripe`) skip the fixture server.
- For each case, the runner creates a fresh temp app dir seeded with
  minimal `package.json` + `README.md` stubs. The sandbox tool resolves
  file host calls (`read_file`, `list_files`, `file_stats`) against
  this directory.
- The runner invokes the **real** `executeSandboxScriptTool.execute`.
  Its description is rebuilt per turn via
  `buildExecuteSandboxScriptDescription()` so the LLM sees the same
  MCP type-defs block production users would see.
- Alongside `execute_sandbox_script`, the runner registers no-op stubs
  for the rest of the production agent toolset (see
  `buildProductionToolStubs` in `mcp/harness.ts`) so the production
  system prompt — which references those tools — does not mislead the
  model into calling tools that don't exist.
- `requireMcpToolConsent`, `readSettings`, `sendTelemetryEvent`, and
  `collectMcpToolDefs` are mocked at the module level. Everything else
  (sandbox execution, MCP transport, capability map, consent wrapper,
  XML emission) runs the production code.
- Each MCP tool call is recorded in `record.json` under `mcpCalls` and
  rendered to `record.txt`. Sandbox scripts are recorded under
  `sandboxScripts`. The judge sees both transcripts.

### Cases

`mcp/cases.ts` ships cases grouped by which MCP server they exercise:

- **`chrome_devtools`** — browser-MCP cases against the local fixture
  HTTP server. Patterns include single call, data-dependent chain,
  loop-and-aggregate, filter-and-return, mixed file + MCP, error
  handling, consent denial recovery, and a negative case that should
  answer without any MCP call.
- **`stripe`** — cases against the live Stripe API in test mode.
  Read-only by design (documentation search, balance retrieval,
  list-and-count, consent denial recovery) so they pass on a fresh
  test account without pre-seeded customers, products, or balances.
- **`linear`** — cases against the live Linear API via OAuth.
  Read-only (list teams, identify authenticated user, consent denial
  recovery) so they pass against any workspace the user grants `read`
  scope to.

See `mcp/cases.ts` for the current case list — the README is not the
source of truth for which cases exist.

Each case declares a `server` key (one of the registered specs in
`mcp/servers/`) plus optional fields:

- `expectedToolNameContains: string[]` — every entry must match at
  least one recorded MCP call's `jsName` or `toolName`. Entries
  support `|`-alternation so synonymous tools count as one match
  (e.g. `"navigate_page|new_page"`).
- `expectedAnswerContains: string[]` — every entry must appear (case
  insensitive) in the model's final assistant text. Entries also
  support `|`-alternation.
- `expectNoMcpCalls: true` — fails if any MCP call was made.
- `denyFirstConsent: true` — installs a consent decider that denies
  only the first MCP call, exercising recovery.
- `setupFile: { name, contents }` — file written into the per-case
  temp app dir before the model runs (for cases that exercise file
  host calls inside `execute_sandbox_script`).

Verdict order per case: structural checks (above) → LLM judge
(`JUDGE_MODEL` in `tool_use.eval.ts`) sees the prompt, MCP transcript,
sandbox-script transcript, and final answer, and returns PASS/FAIL.

### Running

```bash
# Default — runs only the chrome_devtools cases.
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet DYAD_PRO_API_KEY="..." npm run eval

# Run the Stripe cases only (requires STRIPE_API_KEY — see below).
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet EVAL_MCP_SERVERS=stripe \
  STRIPE_API_KEY="sk_test_..." DYAD_PRO_API_KEY="..." npm run eval

# Run the Linear cases only (requires LINEAR_CLIENT_ID + interactive
# terminal on first run for OAuth — see below).
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet EVAL_MCP_SERVERS=linear \
  LINEAR_CLIENT_ID="..." DYAD_PRO_API_KEY="..." npm run eval

# Run every MCP server spec (chrome_devtools + stripe + linear).
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet EVAL_MCP_SERVERS=all \
  STRIPE_API_KEY="sk_test_..." LINEAR_CLIENT_ID="..." \
  DYAD_PRO_API_KEY="..." npm run eval
```

`EVAL_MCP_SERVERS` selects which MCP server specs (`mcp/servers/`) run
this invocation. Default is `chrome_devtools`. Pass a comma-separated
list of keys, or `all`. Each server spec runs its own per-case probe;
an unconfigured spec (missing API key, server binary not reachable)
skips its cases without failing the run. The `mcp_execute` suite can
also be combined with file-edit suites (e.g.
`EVAL_SUITE=pro_agent,mcp_execute` or `EVAL_SUITE=all`).

### Environment variables

In addition to `EVAL_SUITE`, `EVAL_MODEL`, and `DYAD_PRO_API_KEY` (see
above for the file-edit suites), the MCP suite reads:

| Variable           | Default           | Purpose                                                                                                                                                                                                       |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVAL_MCP_SERVERS` | `chrome_devtools` | Comma-separated list of MCP server keys to spawn (or `all`). The set of available keys is whatever `MCP_SERVER_SPECS` in `mcp/servers/index.ts` exports — unknown keys fail at startup with the current list. |
| `EVAL_OAUTH_AUTO`  | _(unset)_         | Set to `1` to allow OAuth flows to run in a non-TTY environment (CI). By default OAuth-protected specs skip when stdin is not a TTY and no token is cached.                                                   |

Per-spec env vars:

#### `chrome_devtools`

| Variable                   | Default                          | Purpose                                                                                                                                     |
| -------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVAL_MCP_COMMAND`         | `npx`                            | Binary used to spawn the MCP server. Override to use a globally installed `chrome-devtools-mcp` (skips the `npx` resolution step).          |
| `EVAL_MCP_PACKAGE`         | `chrome-devtools-mcp@latest`     | Package spec passed to `npx`. Pin a specific version for reproducibility / supply-chain safety (e.g. `chrome-devtools-mcp@0.x.y`).          |
| `EVAL_MCP_EXECUTABLE_PATH` | _(unset)_                        | Path to a Chrome/Chromium-compatible binary. Forwarded as `--executablePath=<path>`. Required when no Chrome is on `PATH` (e.g. AppImages). |
| `EVAL_MCP_HEADLESS`        | `true` (i.e. `--headless` added) | Set to `"false"` to disable headless mode and watch the browser window during eval runs. Useful for debugging case behavior visually.       |
| `EVAL_MCP_EXTRA_ARGS`      | _(unset)_                        | Extra args appended verbatim to the MCP server invocation, space-separated. Example: `EVAL_MCP_EXTRA_ARGS="--chrome-arg=--no-sandbox"`.     |

Safe defaults baked in regardless of env vars: `--isolated`
(ephemeral user-data-dir, auto-cleaned), `--headless` (unless
overridden), `--no-usage-statistics` (no analytics traffic from eval
runs).

#### `stripe`

| Variable                     | Default       | Purpose                                                                                                                                                                                                                      |
| ---------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_API_KEY`             | _(unset)_     | **Required.** Stripe API key forwarded as `--api-key=<key>`. Must be a **test-mode** key (`sk_test_...` or `rk_test_...`) — the spec's probe rejects anything else, so an eval run cannot accidentally drive a live account. |
| `EVAL_STRIPE_MCP_COMMAND`    | `npx`         | Binary used to spawn the MCP server.                                                                                                                                                                                         |
| `EVAL_STRIPE_MCP_PACKAGE`    | `@stripe/mcp` | Package spec passed to `npx`. Pin a specific version for reproducibility (e.g. `@stripe/mcp@0.3.3`).                                                                                                                         |
| `EVAL_STRIPE_MCP_EXTRA_ARGS` | _(unset)_     | Extra args appended verbatim to the MCP server invocation, space-separated.                                                                                                                                                  |

The Stripe cases hit the live Stripe API — they are read-only by
default (docs search, balance retrieval, customer listing) so they pass
on a fresh test account, but they DO send real requests to Stripe.
Never point this at an `sk_live_...` / `rk_live_...` key.

`@stripe/mcp` is a stdio→HTTP proxy that forwards MCP messages to
`https://mcp.stripe.com`. Tool permissions are controlled by your API
key's scopes — use a Restricted API Key (`rk_test_...`) scoped to the
operations you want the eval to perform (the deprecated `--tools`
allowlist no longer exists).

#### `linear`

Linear's MCP server is a **remote** server at
`https://mcp.linear.app/sse` (SSE transport — server-sent events, not
streamable HTTP), gated by Linear OAuth 2.0 with PKCE. The eval suite
walks the OAuth flow interactively on first run, caches the resulting
access token under `~/.cache/dyad-eval/oauth/linear.json` (mode
`0600`), and reuses it on subsequent runs until expiry.

##### One-time Linear OAuth app setup

1. Sign in to your Linear workspace and visit
   https://linear.app/settings/api/applications.
2. Click "Create new" (or similar) to register a new OAuth application.
3. Fill in the form. **Only three fields actually affect the eval**:
   - **Callback URLs** (a.k.a. redirect URIs): set to exactly
     `http://localhost:53682/callback`. If you want a different port,
     pick one between 1024 and 65535 and export
     `EVAL_LINEAR_OAUTH_PORT=<port>` to match. Linear requires the
     redirect URI to be pre-registered down to the port, so this must
     be exact.
   - **Scopes**: enable at least `read`. The shipped Linear cases are
     all read-only. If you add cases that mutate workspace data,
     widen this and set `EVAL_LINEAR_SCOPE` accordingly.
   - **Public** vs **Confidential**: public PKCE apps don't need a
     client secret. If Linear marks your app as confidential anyway,
     export `LINEAR_CLIENT_SECRET` alongside the client ID.

   The other fields (application name, description, icon, developer
   info, webhook URL, privacy/TOS URLs) are Linear-side metadata for
   the consent screen and app gallery. **None of them affect whether
   the eval passes** — fill them in if Linear requires it for app
   creation, otherwise stub anything that's allowed to be empty.

4. After saving, copy the **Client ID** from the app's detail page.
   Export it as `LINEAR_CLIENT_ID`.

##### Env vars

| Variable                 | Default   | Purpose                                                                                                                                                                                                                |
| ------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LINEAR_CLIENT_ID`       | _(unset)_ | **Required.** Client ID of your registered Linear OAuth application.                                                                                                                                                   |
| `LINEAR_CLIENT_SECRET`   | _(unset)_ | Client Secret, if Linear treats your OAuth app as confidential. Public PKCE clients don't need one — try without it first; add it only if the token endpoint rejects the exchange.                                     |
| `EVAL_LINEAR_OAUTH_PORT` | `53682`   | TCP port the loopback callback listener binds to. **Must match the port in your Linear OAuth app's callback URL exactly** — Linear (like most OAuth providers) pins redirect URIs to a specific port at the app level. |
| `EVAL_LINEAR_SCOPE`      | `read`    | Space-separated OAuth scopes requested at the authorize endpoint. The shipped cases only need `read`. Use a wider scope (e.g. `read write`) if you add cases that mutate Linear data.                                  |

##### First run (acquire the token)

Vitest runs tests in worker threads where `process.stdin.isTTY` is
undefined, so the OAuth helper would normally refuse to prompt. Opt
in with `EVAL_OAUTH_AUTO=1` (`EVAL_OAUTH_AUTO` overrides the TTY
check — fine when you're running locally and watching the terminal,
unsafe in headless CI).

```bash
EVAL_OAUTH_AUTO=1 \
LINEAR_CLIENT_ID="<your client id>" \
DYAD_PRO_API_KEY="<your dyad key>" \
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet EVAL_MCP_SERVERS=linear \
  npm run eval -- -t "List teams"
```

What happens:

1. Eval starts, hits the linear spec's `beforeAll`, calls the OAuth
   helper.
2. Helper prints the authorize URL to the terminal and tries to open
   it in your default browser (`xdg-open` / `open` / `start`).
3. You log in to Linear, approve the requested scopes.
4. Linear redirects to
   `http://localhost:53682/callback?code=...&state=...`.
5. Helper's local listener captures the code, exchanges it for an
   access token at `https://api.linear.app/oauth/token`, writes the
   token to `~/.cache/dyad-eval/oauth/linear.json` (mode `0600`).
6. Eval continues, runs the case, judge votes.

The `-t "List teams"` filter restricts to one case so the first run
finishes fast and you don't burn a long matrix on the OAuth round
trip.

##### Subsequent runs (token cached)

Drop `EVAL_OAUTH_AUTO=1` and the `-t` filter. The helper reads the
cached token, no prompt:

```bash
LINEAR_CLIENT_ID="<your client id>" \
DYAD_PRO_API_KEY="<your dyad key>" \
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet EVAL_MCP_SERVERS=linear \
  npm run eval
```

To force a fresh OAuth flow (e.g. you revoked the app, expired the
token, or want to test the flow itself again), delete
`~/.cache/dyad-eval/oauth/linear.json` and rerun the first-run
command above.

##### Troubleshooting

| Symptom                                                         | Likely cause                                                                    | Fix                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `LINEAR_CLIENT_ID not set` (case skipped)                       | Env var missing                                                                 | Export `LINEAR_CLIENT_ID`                                                                   |
| `No cached OAuth token ... not a TTY` (case skipped)            | Vitest worker has no TTY, no cached token                                       | Set `EVAL_OAUTH_AUTO=1` for the first run                                                   |
| Browser opens to Linear, says "redirect URI doesn't match"      | Callback URL on the Linear app doesn't match `EVAL_LINEAR_OAUTH_PORT`           | Set them equal — the URI must be `http://localhost:<EVAL_LINEAR_OAUTH_PORT>/callback`       |
| Authorize succeeds, then `Error POSTing to endpoint (HTTP 404)` | Wrong transport class against `https://mcp.linear.app/sse`                      | Already fixed (uses `SSEClientTransport`) — re-pull `mcp/servers/linear.ts` if you see this |
| `Token endpoint returned 401`                                   | Linear flagged your app as confidential and is rejecting the PKCE-only exchange | Export `LINEAR_CLIENT_SECRET` from the same app's detail page                               |
| `Failed to bind OAuth callback listener on port 53682`          | Another process holds the port                                                  | `lsof -i :53682` to find it, or pick a different port via `EVAL_LINEAR_OAUTH_PORT`          |

### Examples

Run against a system Chrome with headless on:

```bash
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet DYAD_PRO_API_KEY="..." npm run eval
```

Run against a non-default Chromium build (e.g. a packaged Chromium
binary, an alternative Chromium-derived browser, or any
Chrome-compatible install not on `PATH`) with the window visible:

```bash
EVAL_MCP_EXECUTABLE_PATH=/path/to/chromium \
EVAL_MCP_HEADLESS=false \
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet DYAD_PRO_API_KEY="..." npm run eval
```

Run with a sandboxed Chromium that needs `--no-sandbox` (common with
packaged builds like AppImages) and a debug log file:

```bash
EVAL_MCP_EXTRA_ARGS="--chrome-arg=--no-sandbox --logFile=/tmp/cdt-mcp.log" \
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet DYAD_PRO_API_KEY="..." npm run eval
```

Run a single MCP case (vitest substring filter):

```bash
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet DYAD_PRO_API_KEY="..." \
  npm run eval -- -t "Consent denied"
```

### Safety notes

The MCP suite drives **real external services**, not sandboxed/fake
ones, and the consent layer is mocked to auto-approve every call.
Treat it like an integration test.

`chrome_devtools`:

- The model can navigate to any URL — the fixture server origin is
  not enforced as an allowlist. A misbehaving model could navigate to
  arbitrary external sites with your real IP and browser
  fingerprint.
- `npx -y chrome-devtools-mcp@latest` pulls the latest release from
  npm. Pin a version via `EVAL_MCP_PACKAGE` to reduce supply-chain
  risk in long-lived environments.
- The `--isolated` flag means the spawned browser uses an ephemeral
  user-data-dir that is wiped after each run — your real Chrome
  profile, cookies, and logged-in sessions are not exposed.
- Don't run this suite on a machine with sensitive credentials in
  the default browser profile or in CI without network egress
  restrictions.

`stripe`:

- The model issues real Stripe API requests against the account
  whose key is in `STRIPE_API_KEY`. The probe refuses anything other
  than a test-mode key (`sk_test_...` / `rk_test_...`) — never
  override that.
- Even in test mode the model can in principle invoke
  state-changing tools (create customers, products, payment links,
  etc.). The shipped cases are read-only, but the hosted Stripe MCP
  server exposes write tools based on your API key's scopes. Use a
  Restricted API Key (`rk_test_...`) scoped to read-only operations
  if you want to forbid mutations at the auth layer.
- `npx -y @stripe/mcp` pulls the latest release from npm. Pin a
  version via `EVAL_STRIPE_MCP_PACKAGE` to reduce supply-chain risk.

`linear`:

- The model issues real Linear API requests against the workspace
  whose OAuth token is cached. Cached tokens grant whatever scopes
  you approved at the authorize step — keep that scope `read` unless
  you actively want cases that mutate Linear data.
- The OAuth access token sits in plaintext at
  `~/.cache/dyad-eval/oauth/linear.json` with mode `0600`. Anyone
  with read access to that file can act as you against the Linear
  API. Don't commit it, don't sync that path to other machines, and
  delete it when you're done if your machine is shared.
- The first run prints the authorize URL and opens your default
  browser. The URL contains the OAuth `state` and PKCE
  `code_challenge` — anyone observing your terminal could in
  principle race you to the redirect and intercept the `code`. Use
  this only on a trusted local terminal.
- Linear's MCP `state` param protects against cross-site request
  forgery at the callback boundary; the helper verifies the returned
  `state` matches what it sent and rejects on mismatch.
