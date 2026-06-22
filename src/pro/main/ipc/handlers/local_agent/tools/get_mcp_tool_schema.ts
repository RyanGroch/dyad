import { z } from "zod";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { buildMcpTypeDefsBlock, resolveMcpToolDefs } from "./mcp_type_defs";
import { readSettings } from "@/main/settings";

const getMcpToolSchemaSchema = z.object({
  tools: z
    .array(z.string())
    .min(1)
    .describe(
      "Names of the MCP tools to fetch full TypeScript signatures for, as " +
        "listed in execute_sandbox_script (e.g. ['github__issue_write']).",
    ),
});

type GetMcpToolSchemaArgs = z.infer<typeof getMcpToolSchemaSchema>;

/**
 * Return the full TypeScript `declare function` signatures (input schemas
 * included) for named MCP tools. The list-mode counterpart to
 * `search_mcp_tools`: instead of inlining every tool's schema up front, the
 * `execute_sandbox_script` description lists each tool's name + description
 * only, and the model calls this to pull the schemas for the tools it
 * actually intends to use before calling them as host functions.
 *
 * Only registered when MCP-in-sandbox is active AND the `enableMcpToolList`
 * experiment is on. When off, the tool is absent and the description either
 * inlines every schema (default) or points at `search_mcp_tools`.
 */
export const getMcpToolSchemaTool: ToolDefinition<GetMcpToolSchemaArgs> = {
  name: "get_mcp_tool_schema",
  description:
    "Get the full TypeScript signature(s) of MCP tools by name. The MCP " +
    "tools listed in execute_sandbox_script show only names and " +
    "descriptions; call this to get a tool's input schema before calling it " +
    "as a host function inside a script.",
  inputSchema: getMcpToolSchemaSchema,
  defaultConsent: "always",

  // ctx.mcpToolsEnabled already implies sandbox-script execution is on, so only
  // the experiment flag needs a separate check.
  isEnabled: (ctx) =>
    !!ctx.mcpToolsEnabled && !!readSettings().enableMcpToolList,

  getConsentPreview: (args) =>
    `Get schema for MCP tool(s): ${args.tools.join(", ")}`,

  buildXml: (args, isComplete) => {
    if (!args.tools || args.tools.length === 0) return undefined;
    if (isComplete) return undefined;
    return `<dyad-mcp-tool-schema tools="${escapeXmlAttr(args.tools.join(", "))}">Loading...`;
  },

  execute: async (args: GetMcpToolSchemaArgs, ctx: AgentContext) => {
    const finish = (result: string) => {
      ctx.onXmlComplete(
        `<dyad-mcp-tool-schema tools="${escapeXmlAttr(args.tools.join(", "))}">${escapeXmlContent(result)}</dyad-mcp-tool-schema>`,
      );
      return result;
    };

    // No defs means the handler's collection failed and the sandbox has no MCP
    // host functions this turn, so don't hand the model tools it can't call.
    if (ctx.mcpToolDefs === undefined) {
      return finish("MCP tools are temporarily unavailable. Try again.");
    }

    const { found, missing } = resolveMcpToolDefs(ctx.mcpToolDefs, args.tools);

    if (found.length === 0) {
      return finish(
        `No MCP tool matched [${args.tools.join(", ")}]. Use the names exactly ` +
          `as listed in execute_sandbox_script.`,
      );
    }

    const block = buildMcpTypeDefsBlock(found);
    const missingNote =
      missing.length > 0 ? `\n\n// No match for: ${missing.join(", ")}` : "";

    return finish(
      `Signature(s) for ${found.length} MCP tool(s). Call these as host ` +
        `functions inside execute_sandbox_script:\n\n${block}${missingNote}`,
    );
  },
};
