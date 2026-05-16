import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Track every render of the inner ReactMarkdown component keyed by the
// content string it received. The DyadMarkdownParser wraps ReactMarkdown
// inside a React.memo'd MemoMarkdown, so a call here means the memo did
// not short-circuit — i.e. the block actually re-rendered.
const markdownRenderCounts = new Map<string, number>();

vi.mock("react-markdown", () => ({
  default: function MockReactMarkdown({ children }: { children: string }) {
    markdownRenderCounts.set(
      children,
      (markdownRenderCounts.get(children) ?? 0) + 1,
    );
    return null;
  },
}));

vi.mock("../preview_panel/FileEditor", () => ({
  FileEditor: () => null,
}));

import { DyadMarkdownParser } from "./DyadMarkdownParser";

describe("DyadMarkdownParser dyad-status", () => {
  afterEach(() => {
    cleanup();
  });

  it("honors explicit aborted state on closed status tags", () => {
    render(
      <DyadMarkdownParser
        content={
          '<dyad-status title="Supabase functions failed" state="aborted">\n0 succeeded\n1 failed\n</dyad-status>'
        }
      />,
    );

    const statusCard = screen.getByRole("button");

    expect(screen.getByText("Supabase functions failed")).toBeTruthy();
    expect(statusCard.className).toContain("border-l-red-500");
  });
});

describe("DyadMarkdownParser closed-block render counts", () => {
  beforeEach(() => {
    markdownRenderCounts.clear();
  });
  afterEach(() => {
    cleanup();
  });

  // Three markdown segments separated by two closed dyad-status tags.
  // After the parser consumes everything, each markdown segment becomes
  // its own closed Block whose `content` is exactly the bytes between
  // the previous tag's `>` and the next tag's `<`. We put the `\n\n`
  // separators on the markdown-side of the constants so each constant
  // matches the closed Block's content string verbatim.
  const MD1 = "First paragraph content.\n\n";
  const TAG1 = '<dyad-status title="S1" state="finished">ok</dyad-status>';
  const MD2 = "\n\nSecond paragraph content.\n\n";
  const TAG2 = '<dyad-status title="S2" state="finished">ok</dyad-status>';
  const MD3 = "\n\nThird paragraph content.";
  const FULL = MD1 + TAG1 + MD2 + TAG2 + MD3;

  it("renders each markdown block exactly once for a one-shot parse", () => {
    render(<DyadMarkdownParser content={FULL} />);

    // MD1 / MD2 are closed markdown blocks. MD3 is the trailing open block
    // (parser only closes a markdown block when a custom tag opens after
    // it). All three should reach the inner ReactMarkdown exactly once.
    expect(markdownRenderCounts.get(MD1)).toBe(1);
    expect(markdownRenderCounts.get(MD2)).toBe(1);
    expect(markdownRenderCounts.get(MD3)).toBe(1);
  });

  it("does not re-render closed markdown blocks as later content streams in", () => {
    // Each markdown block closes when the parser consumes the '>' of the
    // next custom tag's opening. After close, the closed-block's MemoMarkdown
    // should never re-execute even though many more chunks arrive.
    const md1ClosesAt = MD1.length + TAG1.indexOf(">") + 1;
    const md2ClosesAt =
      MD1.length + TAG1.length + MD2.length + TAG2.indexOf(">") + 1;

    // Phase 1: render up through the chunk that closes MD1.
    const { rerender } = render(
      <DyadMarkdownParser content={FULL.slice(0, md1ClosesAt)} />,
    );
    const md1AfterClose = markdownRenderCounts.get(MD1) ?? 0;
    expect(md1AfterClose).toBeGreaterThanOrEqual(1);

    // Phase 2: stream one character at a time through MD2's close.
    for (let i = md1ClosesAt + 1; i <= md2ClosesAt; i++) {
      rerender(<DyadMarkdownParser content={FULL.slice(0, i)} />);
    }
    const md2AfterClose = markdownRenderCounts.get(MD2) ?? 0;
    expect(md2AfterClose).toBeGreaterThanOrEqual(1);

    // MD1 already closed; the renders in phase 2 should leave its count
    // untouched. This is the property the component-local parser cache
    // unlocks: a closed block's content prop is referentially stable, so
    // React.memo skips its subtree on every subsequent chunk.
    expect(markdownRenderCounts.get(MD1)).toBe(md1AfterClose);

    // Phase 3: stream through the rest of the message. Both MD1 and MD2
    // are already closed; neither should re-render.
    for (let i = md2ClosesAt + 1; i <= FULL.length; i++) {
      rerender(<DyadMarkdownParser content={FULL.slice(0, i)} />);
    }
    expect(markdownRenderCounts.get(MD1)).toBe(md1AfterClose);
    expect(markdownRenderCounts.get(MD2)).toBe(md2AfterClose);
  });
});
