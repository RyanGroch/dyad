import type { Message } from "@/ipc/types";

/**
 * djb2 hash of the first `length` characters of `s`.
 * Used to validate the agreed-upon prefix in streaming patches so that
 * stale-base mismatches anywhere in the prefix — not just at offset-1 — are detected.
 */
export function hashPrefix(s: string, length: number): number {
  let hash = 5381;
  for (let i = 0; i < length; i++) {
    hash = (((hash << 5) + hash) ^ s.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Merges a DB messages snapshot into the live renderer messages for a chat.
 * For the streaming message, keeps the live version only when it is a valid
 * extension of the DB snapshot: live content must be longer AND its prefix up
 * to the DB snapshot length must hash-match (proving patches advanced the
 * renderer correctly past the snapshot without corrupting the base).
 * Falls back to the DB version otherwise, including when live content is longer
 * but has a wrong prefix (corrupted base that caused the patch failure).
 */
export function mergeResyncMessages(
  dbMessages: Message[],
  prevMessages: Message[],
): Message[] {
  return dbMessages.map((dbMsg) => {
    const live = prevMessages.find((m) => m.id === dbMsg.id);
    if (!live) return dbMsg;
    const dbLen = dbMsg.content?.length ?? 0;
    const liveLen = live.content?.length ?? 0;
    if (
      liveLen > dbLen &&
      hashPrefix(live.content ?? "", dbLen) ===
        hashPrefix(dbMsg.content ?? "", dbLen)
    ) {
      return live;
    }
    return dbMsg;
  });
}
