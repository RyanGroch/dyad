// Static HTML fixtures served by `fixture_server.ts`. Hand-written so the
// MCP cases have deterministic page content to navigate / scrape.
//
// Add a page by adding an entry here. Paths must start with `/`.

export interface FixturePage {
  path: string;
  title: string;
  html: string;
}

const homePage: FixturePage = {
  path: "/",
  title: "Dyad MCP Eval Fixture — Home",
  html: `<!doctype html>
<html lang="en">
  <head><title>Dyad MCP Eval Fixture — Home</title></head>
  <body>
    <h1 id="page-title">Welcome to the MCP Eval Fixture</h1>
    <p>This page is served by the eval suite's local fixture server.</p>
    <ul id="nav">
      <li><a href="/products">Products</a></li>
      <li><a href="/orders">Orders</a></li>
      <li><a href="/about">About</a></li>
    </ul>
  </body>
</html>`,
};

const productsPage: FixturePage = {
  path: "/products",
  title: "Products — Dyad MCP Eval Fixture",
  html: `<!doctype html>
<html lang="en">
  <head><title>Products — Dyad MCP Eval Fixture</title></head>
  <body>
    <h1>Products</h1>
    <table id="products">
      <thead><tr><th>SKU</th><th>Name</th><th>Price</th></tr></thead>
      <tbody>
        <tr><td>SKU-001</td><td>Widget</td><td>$12.50</td></tr>
        <tr><td>SKU-002</td><td>Gadget</td><td>$24.00</td></tr>
        <tr><td>SKU-003</td><td>Doodad</td><td>$5.75</td></tr>
      </tbody>
    </table>
  </body>
</html>`,
};

const ordersPage: FixturePage = {
  path: "/orders",
  title: "Orders — Dyad MCP Eval Fixture",
  html: `<!doctype html>
<html lang="en">
  <head><title>Orders — Dyad MCP Eval Fixture</title></head>
  <body>
    <h1>Orders</h1>
    <div id="order-count" data-count="3">3 open orders</div>
    <button id="refresh">Refresh</button>
  </body>
</html>`,
};

const aboutPage: FixturePage = {
  path: "/about",
  title: "About — Dyad MCP Eval Fixture",
  html: `<!doctype html>
<html lang="en">
  <head><title>About — Dyad MCP Eval Fixture</title></head>
  <body>
    <h1>About</h1>
    <p>Build: <span id="build-id">eval-fixture-2026.05</span></p>
  </body>
</html>`,
};

export const FIXTURE_PAGES: FixturePage[] = [
  homePage,
  productsPage,
  ordersPage,
  aboutPage,
];
