/**
 * Failures already reported as `external_api:error`. Kept apart from the
 * reporter so `telemetry.ts` can check it without importing that module.
 */
const reported = new WeakSet<object>();

export function markExternalApiFailureReported(value: object): void {
  reported.add(value);
}

/**
 * Whether this error, or one it wraps through `cause`, came from a failure
 * that was already reported. A Vercel SDK error carries the response it
 * was built from as `rawResponse`, so that is checked too.
 */
export function isExternalApiFailureReported(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if (reported.has(current)) return true;
    const rawResponse = (current as { rawResponse?: unknown }).rawResponse;
    if (
      typeof rawResponse === "object" &&
      rawResponse !== null &&
      reported.has(rawResponse)
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
