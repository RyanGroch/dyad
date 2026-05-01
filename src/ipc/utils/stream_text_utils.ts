/**
 * Computes a tail-only streaming patch from `lastSentContent` to `fullResponse`
 * using longest-common-prefix. Returns null when nothing changed.
 *
 * The renderer reconstructs the full string as `current.slice(0, offset) + content`.
 * We use LCP rather than assuming pure appends because `cleanFullResponse` may
 * retroactively rewrite bytes inside in-progress dyad-tag attribute values.
 */
export function computeStreamingPatch(
  fullResponse: string,
  lastSentContent: string,
): { offset: number; content: string } | null {
  let lcp = 0;
  const maxLcp = Math.min(lastSentContent.length, fullResponse.length);
  while (
    lcp < maxLcp &&
    lastSentContent.charCodeAt(lcp) === fullResponse.charCodeAt(lcp)
  ) {
    lcp++;
  }
  const tail = fullResponse.slice(lcp);
  if (tail.length === 0 && lcp === lastSentContent.length) {
    return null;
  }
  return { offset: lcp, content: tail };
}
