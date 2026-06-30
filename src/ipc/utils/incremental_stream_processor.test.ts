import { describe, expect, it } from "vitest";
import { createStreamProcessor } from "./incremental_stream_processor";
import { cleanFullResponse } from "./cleanFullResponse";
import { hashPrefix } from "@/lib/prefixHash";

// Split `s` into chunks of fixed size.
function fixedChunks(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

// Deterministic PRNG so failures reproduce.
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feed(content: string, chunks: string[]): string {
  const p = createStreamProcessor();
  for (const c of chunks) p.push(c);
  return p.getFullContent();
}

const CASES = [
  "",
  "just some prose with no tags",
  "prose with a lone < bracket and > too",
  "<div>not a dyad tag</div>",
  '<dyad-write path="src/a.ts">body</dyad-write>',
  '<dyad-write path="a<b>c" description="x">code</dyad-write>',
  'before <dyad-write path="a.ts" description="has > and < inside">x</dyad-write> after',
  '<dyad-write path="x"></dyad-write><dyad-rename from="a" to="b"></dyad-rename>',
  "text <dyad-execute-sql>SELECT * FROM t WHERE a < 5 AND b > 3</dyad-execute-sql> more",
  "partial <dy",
  '<dyad-write path="unterminated',
  'a<dyad-a <dyad-write path="x>y">z</dyad-write>',
  '<<<>>><dyad-write path="a">q</dyad-write>',
];

describe("incremental stream processor", () => {
  it("getFullContent equals whole-string cleanFullResponse for fixed splits", () => {
    for (const content of CASES) {
      const expected = cleanFullResponse(content);
      for (const size of [1, 2, 3, 5, 13, 1000]) {
        const got = feed(content, fixedChunks(content, size));
        expect(got, `case=${JSON.stringify(content)} size=${size}`).toBe(
          expected,
        );
      }
    }
  });

  it("matches cleanFullResponse for random content + random chunk splits", () => {
    const rand = mulberry32(42);
    const pieces = [
      "lorem ipsum ",
      '<dyad-write path="f.ts" description="d">',
      "const x = 1 < 2 && 3 > 2;\n",
      "</dyad-write>",
      "\nprose < > prose\n",
      "<dyad-execute-sql>a < b</dyad-execute-sql>",
      "<not-a-tag>",
      "<dyad-",
    ];
    for (let iter = 0; iter < 400; iter++) {
      let content = "";
      const parts = 1 + Math.floor(rand() * 12);
      for (let k = 0; k < parts; k++) {
        content += pieces[Math.floor(rand() * pieces.length)];
      }
      // Random chunking.
      const chunks: string[] = [];
      let i = 0;
      while (i < content.length) {
        const size = 1 + Math.floor(rand() * 7);
        chunks.push(content.slice(i, i + size));
        i += size;
      }
      expect(feed(content, chunks), `iter=${iter} content=${content}`).toBe(
        cleanFullResponse(content),
      );
    }
  });

  it("emitted patches reconstruct the cleaned content (renderer-side replay)", () => {
    for (const content of CASES) {
      const expected = cleanFullResponse(content);
      const p = createStreamProcessor();
      let rendered = "";
      for (const c of fixedChunks(content, 3)) {
        p.push(c);
        const patch = p.takePatch();
        if (!patch) continue;
        // Renderer's stale-base guard must pass.
        if (patch.prefixHash !== undefined) {
          expect(hashPrefix(rendered, patch.offset)).toBe(patch.prefixHash);
        }
        rendered = rendered.slice(0, patch.offset) + patch.content;
      }
      // Final flush patch.
      const last = p.takePatch();
      if (last) rendered = rendered.slice(0, last.offset) + last.content;
      expect(rendered, `case=${JSON.stringify(content)}`).toBe(expected);
    }
  });
});
