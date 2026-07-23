import { describe, expect, it } from "vitest";
import { classifySshError } from "./ssh_utils";

describe("classifySshError", () => {
  it.each([
    ["Permission denied (publickey).", 255, "auth-rejected"],
    [
      "@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @",
      255,
      "host-key-changed",
    ],
    ["Host key verification failed.", 255, "host-key-changed"],
    ["ssh: connect to host 1.2.3.4 port 22: Connection timed out", 255, "timeout"],
    ["ssh: Could not resolve hostname example.invalid", 255, "unreachable"],
    ["ssh: connect to host 1.2.3.4 port 22: Connection refused", 255, "unreachable"],
    ["something else entirely", 255, "unknown"],
  ])("classifies %s", (stderr, code, expected) => {
    expect(classifySshError(stderr, code)).toBe(expected);
  });

  it("treats a null exit code as a timeout (killed by our timer)", () => {
    expect(classifySshError("", null)).toBe("timeout");
  });
});
