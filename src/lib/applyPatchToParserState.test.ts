import { describe, expect, it } from "vitest";
import {
  getParserBlocks,
  initialParserState,
  parseFullMessage,
  type Block,
  type ParserState,
} from "@/lib/streamingMessageParser";
import { applyPatchToParserState } from "@/lib/applyPatchToParserState";

function blocksToShape(blocks: Block[]) {
  return blocks.map((b) =>
    b.kind === "markdown"
      ? { kind: "markdown", content: b.content, complete: b.complete }
      : {
          kind: "custom-tag",
          tag: b.tag,
          attributes: b.attributes,
          content: b.content,
          complete: b.complete,
          inProgress: b.inProgress,
        },
  );
}

// Stream `full` through the patch applier in fixed-size append patches, exactly
// as the chunk handler does (offset === bytes already sent).
function streamAppend(full: string, chunk: number): ParserState {
  let state = initialParserState();
  for (let i = 0; i < full.length; i += chunk) {
    const piece = full.slice(i, i + chunk);
    const result = applyPatchToParserState(state, {
      offset: i,
      content: piece,
    });
    expect(result.ok).toBe(true);
    state = result.state!;
  }
  return state;
}

const MULTI_BLOCK = [
  "Intro text before the first tool call.",
  '<dyad-write path="a.ts" description="File A">',
  "console.log(1);\nconsole.log(2);",
  "</dyad-write>",
  "Some prose in the middle.",
  '<dyad-write path="b.ts">',
  "export const x = 42;",
  "</dyad-write>",
  "Done.",
].join("\n");

describe("applyPatchToParserState", () => {
  it("append patches reproduce the one-shot parse at every chunk size", () => {
    const expected = blocksToShape(parseFullMessage(MULTI_BLOCK).blocks);
    for (const chunk of [1, 2, 3, 7, 13, 1000]) {
      const state = streamAppend(MULTI_BLOCK, chunk);
      expect(blocksToShape(getParserBlocks(state))).toEqual(expected);
    }
  });

  it("keeps every block (none dropped) for a many-block stream", () => {
    const blocks: string[] = [];
    for (let i = 0; i < 200; i++) {
      blocks.push(
        `<dyad-write path="file${i}.ts">const n = ${i};</dyad-write>`,
      );
    }
    const full = blocks.join("\n");
    const state = streamAppend(full, 5);
    const tagBlocks = getParserBlocks(state).filter(
      (b) => b.kind === "custom-tag",
    );
    expect(tagBlocks).toHaveLength(200);
  });

  it("never retains more than the current open block (bounded buffer)", () => {
    // Two large file writes, then a tiny trailing markdown. Once the writes
    // commit, openRaw must shrink back to the trailing block, never the whole
    // response.
    const big = "x".repeat(50_000);
    const full =
      `<dyad-write path="a">${big}</dyad-write>` +
      `<dyad-write path="b">${big}</dyad-write>` +
      `tail`;
    const state = streamAppend(full, 4096);
    expect(state.openRaw).toBe("tail");
    expect(state.openRaw.length).toBeLessThan(full.length / 100);
  });

  it("applies a rewrite inside the open tag (re-parses only the open region)", () => {
    // Stream up to a half-written attribute, then the server rewrites the
    // attribute value and finishes the tag (a cleanFullResponse-style edit).
    const partial = 'Intro\n<dyad-write path="aa';
    const state = streamAppend(partial, 3);

    const finalFull = 'Intro\n<dyad-write path="bb.ts">body</dyad-write>';
    const divergeAt = 'Intro\n<dyad-write path="'.length; // first differing byte
    const result = applyPatchToParserState(state, {
      offset: divergeAt,
      content: finalFull.slice(divergeAt),
    });
    expect(result.ok).toBe(true);
    expect(blocksToShape(getParserBlocks(result.state!))).toEqual(
      blocksToShape(parseFullMessage(finalFull).blocks),
    );
  });

  it("signals resync on a forward gap", () => {
    const state = streamAppend("hello world", 4);
    const result = applyPatchToParserState(state, {
      offset: state.cursor + 5,
      content: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.state).toBeUndefined();
  });

  it("signals resync when a rewrite reaches a committed block", () => {
    const state = streamAppend('<dyad-write path="a"></dyad-write>tail', 6);
    expect(state.openRaw).toBe("tail");
    // Offset 2 is inside the already-committed tag (before openBase).
    const result = applyPatchToParserState(state, { offset: 2, content: "X" });
    expect(result.ok).toBe(false);
  });
});
