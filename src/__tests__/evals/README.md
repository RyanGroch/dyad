# Evals

LLM eval suite for tool-use quality. Five file-edit suites run the same 16
cases and the same three models (Claude Sonnet 4.6, GPT 5.4, Gemini 3
Flash) but with different tool sets and system prompts:

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
and then asks an LLM judge (GPT 5.4) whether the result satisfies the
instruction.

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
generation per (suite × model × case) triple plus one judge call per case,
across 5 suites, 3 models, and 16 cases. Expect dozens of LLM requests,
some of which run reasoning models on 300+ line fixtures. Use sparingly;
prefer narrow filters during development.

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
directory:

- `eval-results/search_replace/`
- `eval-results/search_replace_few/`
- `eval-results/basic_agent/`
- `eval-results/pro_agent/`
- `eval-results/pro_agent_experimental/`

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
the file-edit suites, cases here do not edit a fixture file — they have a
user question whose answer requires browsing or scraping a real web page,
and the verdict is the model's final assistant text.

### How it works

- `beforeAll` starts a small Node HTTP server on `127.0.0.1:<random>`
  serving deterministic HTML pages from `mcp/fixture_pages.ts`.
- `beforeAll` spawns `chrome-devtools-mcp` via `npx -y
chrome-devtools-mcp@latest` (configurable — see env vars below),
  injects the live MCP client into `mcpManager`, and registers the
  discovered tool defs in a registry module.
- For each case, the runner creates a fresh temp app dir seeded with
  minimal `package.json` + `README.md` stubs. The sandbox tool resolves
  file host calls (`read_file`, `list_files`, `file_stats`) against
  this directory.
- The runner invokes the **real** `executeSandboxScriptTool.execute`.
  Its description is rebuilt per turn via
  `buildExecuteSandboxScriptDescription()` so the LLM sees the same
  MCP type-defs block production users would see.
- Alongside `execute_sandbox_script`, the runner registers no-op stubs
  for the rest of the production agent toolset (`set_chat_summary`,
  `update_todos`, `search_replace`, `write_file`, `grep`) so the
  production system prompt — which references those tools — does not
  mislead the model into calling tools that don't exist.
- `requireMcpToolConsent`, `readSettings`, `sendTelemetryEvent`, and
  `collectMcpToolDefs` are mocked at the module level. Everything else
  (sandbox execution, MCP transport, capability map, consent wrapper,
  XML emission) runs the production code.
- Each MCP tool call is recorded in `record.json` under `mcpCalls` and
  rendered to `record.txt`. Sandbox scripts are recorded under
  `sandboxScripts`. The judge sees both transcripts.

### Cases

The suite ships with eight cases (see `mcp/cases.ts`) covering
distinct MCP usage patterns: single call, data-dependent chain,
loop-and-aggregate, filter-and-return, mixed file + MCP, error
handling, consent denial recovery, and a negative case that should
answer without any MCP call.

Each case may declare:

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

Verdict order per case: structural checks (above) → LLM judge (GPT
5.4) sees the prompt, MCP transcript, sandbox-script transcript, and
final answer, and returns PASS/FAIL.

### Running

```bash
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet DYAD_PRO_API_KEY="..." npm run eval
```

The suite is skipped (without failing) if `chrome-devtools-mcp` cannot
be reached. It can be combined with file-edit suites
(`EVAL_SUITE=pro_agent,mcp_execute` or `EVAL_SUITE=all`).

### Environment variables

In addition to `EVAL_SUITE`, `EVAL_MODEL`, and `DYAD_PRO_API_KEY` (see
above for the file-edit suites), the MCP suite reads the following:

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

### Examples

Run against a system Chrome with headless on:

```bash
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet DYAD_PRO_API_KEY="..." npm run eval
```

Run against a Helium browser AppImage with the window visible:

```bash
EVAL_MCP_EXECUTABLE_PATH=/path/to/Helium.AppImage \
EVAL_MCP_HEADLESS=false \
EVAL_SUITE=mcp_execute EVAL_MODEL=sonnet DYAD_PRO_API_KEY="..." npm run eval
```

Run with a sandboxed Chromium that needs `--no-sandbox` (common with
AppImages) and a debug log file:

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

The MCP suite drives a **real browser**, not a sandboxed/fake one, and
the consent layer is mocked to auto-approve every call. Treat it like
an integration test:

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
