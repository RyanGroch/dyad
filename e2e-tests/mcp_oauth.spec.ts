import path from "path";
import { spawn } from "child_process";
import { testSkipIfWindows } from "./helpers/test_helper";
import { expect } from "@playwright/test";

testSkipIfWindows("mcp - oauth connects and calls a tool", async ({ po }) => {
  const fakePath = path.join(
    __dirname,
    "..",
    "testing",
    "fake-oauth-mcp-server.mjs",
  );
  const port = 4002;
  const base = `http://localhost:${port}`;

  const fake = spawn("node", [fakePath], {
    env: { ...process.env, PORT: String(port), FAKE_DCR: "1" },
    stdio: "pipe",
  });

  // The fake server doesn't print a single ready line we can grep
  // for; poll its discovery endpoint until it responds.
  await waitForReady(base);

  try {
    await po.setUp();

    // Drive the OAuth authorize URL via fetch (redirect:follow) so
    // the test doesn't open the OS browser. The fake's /authorize
    // auto-redirects to the loopback callback, and Dyad's listener
    // resolves the flow normally.
    await po.electronApp.evaluate(({ shell }) => {
      shell.openExternal = async (url) => {
        await fetch(url, { redirect: "follow" });
      };
    });

    await po.navigation.goToSettingsTab();
    await po.settings.scrollToSettingsSection("experiments");
    await po.settings.toggleEnableMcpServersForBuildMode();
    await po.settings.scrollToSettingsSection("tools-mcp");

    await po.page
      .getByRole("textbox", { name: "My MCP Server" })
      .fill("oauth-test-server");
    await po.page.getByTestId("mcp-transport-select").selectOption("http");
    await po.page.getByPlaceholder("http://localhost:3000").fill(`${base}/mcp`);
    await po.page.getByRole("switch", { name: "Use OAuth" }).click();
    await po.page.getByRole("button", { name: "Add Server" }).click();

    await po.page.getByRole("button", { name: "Connect" }).click();
    await expect(po.page.getByText("OAuth: connected")).toBeVisible({
      timeout: 15_000,
    });

    // Tool call uses the freshly stored bearer token.
    await po.navigation.goToAppsTab();
    await po.chatActions.selectChatMode("build");
    await po.sendPrompt("[call_tool=calculator_add]", {
      skipWaitForCompletion: true,
    });
    await po.snapshotMessages();
    await po.approveProposal();

    await po.sendPrompt("[dump]");
    await po.snapshotServerDump("all-messages");
  } finally {
    fake.kill();
    await new Promise<void>((resolve) => {
      fake.on("exit", () => resolve());
      setTimeout(() => {
        fake.kill("SIGKILL");
        resolve();
      }, 2000);
    });
  }
});

async function waitForReady(base: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${base}/.well-known/oauth-authorization-server`);
      if (r.ok) return;
    } catch {
      // ECONNREFUSED until the fake's listener binds.
    }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`fake-oauth-mcp-server at ${base} never came up`);
}
