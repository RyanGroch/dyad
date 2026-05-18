import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { FIXTURE_PAGES } from "./fixture_pages";

// Local static HTTP server. Started once per eval run, listens on a random
// port, serves the pages from `fixture_pages.ts`. Cases hit it through the
// real chrome-devtools MCP server so the LLM exercises real browser
// navigation against deterministic content (no live-internet flake).

export interface FixtureServer {
  port: number;
  origin: string;
  close: () => Promise<void>;
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const byPath = new Map(FIXTURE_PAGES.map((p) => [p.path, p]));

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";
    const page = byPath.get(url);
    if (!page) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`404 Not Found: ${url}`);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page.html);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  return {
    port,
    origin,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
