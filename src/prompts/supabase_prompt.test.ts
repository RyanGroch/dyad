import { describe, expect, it, vi } from "vitest";
import {
  getSupabaseAvailableSystemPrompt,
  getSupabaseSelfHostedSystemPrompt,
  SUPABASE_AUTH_REDIRECT_RULE,
  SUPABASE_AUTH_BROWSER_EXAMPLE,
} from "./supabase_prompt";

describe("Supabase auth redirect guidance", () => {
  const prompt = getSupabaseAvailableSystemPrompt(
    "// Existing Supabase client",
  );

  it("requires explicit redirects and includes one in the Auth UI example", () => {
    expect(prompt).toContain(SUPABASE_AUTH_REDIRECT_RULE);
    expect(prompt).toContain(
      "redirectTo={new URL('/auth/callback', window.location.origin).href}",
    );
    expect(prompt).toContain(
      "Do not rely on the project's Site URL fallback or change Site URL",
    );
    expect(prompt).toContain(
      "replace hardcoded localhost callbacks and add missing redirect options",
    );
  });

  it.each(["http://app-9.localhost:42999", "https://production.example"])(
    "examples send each flow back to the active origin %s",
    async (origin) => {
      const auth = {
        signInWithOAuth: vi.fn(),
        signUp: vi.fn(),
        signInWithOtp: vi.fn(),
        resetPasswordForEmail: vi.fn(),
      };
      expect(prompt).toContain(SUPABASE_AUTH_BROWSER_EXAMPLE);
      const run = new Function(
        "window",
        "supabase",
        "email",
        "password",
        `return (async () => { ${SUPABASE_AUTH_BROWSER_EXAMPLE} })();`,
      );
      await run(
        { location: { origin } },
        { auth },
        "user@example.com",
        "password",
      );
      expect(auth.signInWithOAuth).toHaveBeenCalledWith({
        provider: "google",
        options: { redirectTo: `${origin}/auth/callback` },
      });
      expect(auth.signUp).toHaveBeenCalledWith({
        email: "user@example.com",
        password: "password",
        options: { emailRedirectTo: `${origin}/auth/callback` },
      });
      expect(auth.signInWithOtp).toHaveBeenCalledWith({
        email: "user@example.com",
        options: { emailRedirectTo: `${origin}/auth/callback` },
      });
      expect(auth.resetPasswordForEmail).toHaveBeenCalledWith(
        "user@example.com",
        { redirectTo: `${origin}/reset-password` },
      );
    },
  );
});

describe("self-hosted Supabase prompt", () => {
  const url = "http://supabase.example.com";

  it("names functions whose update may not be live yet", () => {
    const prompt = getSupabaseSelfHostedSystemPrompt({
      url,
      functionsDeployed: true,
      pendingUpdates: [
        { functionName: "send-email", minutesLeft: 1 },
        { functionName: "charge", minutesLeft: 7 },
      ],
    });

    expect(prompt).toContain(
      "These functions were just updated and may still answer with their previous code: send-email (for up to 1 more minute), charge (for up to 7 more minutes).",
    );
  });

  it("says nothing about updates when none are pending or none are deployed", () => {
    const pendingUpdates = [{ functionName: "send-email", minutesLeft: 3 }];
    for (const prompt of [
      getSupabaseSelfHostedSystemPrompt({ url, functionsDeployed: true }),
      getSupabaseSelfHostedSystemPrompt({
        url,
        functionsDeployed: false,
        pendingUpdates,
      }),
    ]) {
      expect(prompt).not.toContain("just updated");
    }
  });
});
