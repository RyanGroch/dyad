import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildNpxStdioServerSpec } from "./npx_stdio";

// Official filesystem MCP server. No credentials — it operates only on the
// allowed directory passed as a positional arg. We hand it a throwaway temp
// dir so cases can't touch anything real. Pinned version.
//
// Useful near-miss clusters for the search suite: read_text_file /
// read_media_file / read_multiple_files, and list_directory /
// list_directory_with_sizes / directory_tree.

export const filesystemServerSpec = buildNpxStdioServerSpec({
  key: "filesystem",
  serverId: 999_010,
  serverName: "filesystem-eval",
  pkg: "@modelcontextprotocol/server-filesystem@2026.1.14",
  buildArgs: () => {
    const dir = mkdtempSync(resolve(tmpdir(), "dyad-fs-mcp-eval-"));
    return {
      args: [dir],
      cleanup: () => {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best effort
        }
      },
    };
  },
});
