// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { generateSshKeyPair } from "@/testing/fake_ssh_server";
import {
  startFakeEdgeRuntimeSsh,
  type FakeEdgeRuntimeSsh,
} from "@/testing/fake_supabase_edge_runtime_ssh";
import {
  startFakeSupabaseSelfHosted,
  type FakeSupabaseSelfHosted,
} from "@/testing/fake_supabase_self_hosted_server";
import {
  getSupabaseSelfHostedEmailStatus,
  supabaseSelfHostedEmailStatusFrom,
} from "./supabase_self_hosted_email";
import {
  closeSupabaseSelfHostedSessions,
  parseMailSettingsOutput,
} from "./supabase_self_hosted_functions";

/** Recorded from a Coolify Supabase service, shortened to three containers. */
const COOLIFY_OUTPUT = [
  "dyad-container:supabase-auth-t2np\tsupabase/gotrue:v2.186.0\tsupabase-auth",
  "dyad-container:supabase-kong-t2np\tkong/kong:3.9.1\tsupabase-kong",
  "dyad-container:supabase-edge-functions-t2np\tsupabase/edge-runtime:v1.71.2\tsupabase-edge-functions",
  "dyad-auth:supabase-auth-t2np",
  "GOTRUE_MAILER_AUTOCONFIRM=false",
  "GOTRUE_SMTP_HOST=",
  "",
].join("\n");

const withSmtpHost = (host: string) =>
  COOLIFY_OUTPUT.replace("GOTRUE_SMTP_HOST=", `GOTRUE_SMTP_HOST=${host}`);

describe("parseMailSettingsOutput", () => {
  it("reads the auth service's mail settings and the running containers", () => {
    expect(parseMailSettingsOutput(withSmtpHost("smtp.resend.com"))).toEqual({
      smtpHost: "smtp.resend.com",
      autoconfirm: false,
      runningNames: [
        "supabase-auth-t2np",
        "supabase-auth",
        "supabase-kong-t2np",
        "supabase-kong",
        "supabase-edge-functions-t2np",
        "supabase-edge-functions",
      ],
    });
  });

  it("finds nothing when the instance has no auth container", () => {
    expect(parseMailSettingsOutput("")).toBeNull();
  });
});

describe("supabaseSelfHostedEmailStatusFrom", () => {
  const mail = (output: string) => parseMailSettingsOutput(output);

  it("says sign-ups need no email when autoconfirm is on", () => {
    expect(
      supabaseSelfHostedEmailStatusFrom({ autoconfirm: true, mail: null }),
    ).toEqual({ kind: "autoconfirm" });
    // The server's own setting counts when the settings endpoint failed.
    expect(
      supabaseSelfHostedEmailStatusFrom({
        autoconfirm: null,
        mail: mail(
          COOLIFY_OUTPUT.replace("AUTOCONFIRM=false", "AUTOCONFIRM=true"),
        ),
      }),
    ).toEqual({ kind: "autoconfirm" });
  });

  it("knows email is broken with no host or a placeholder container", () => {
    // Coolify: an empty host, so every email is discarded.
    expect(
      supabaseSelfHostedEmailStatusFrom({
        autoconfirm: false,
        mail: mail(COOLIFY_OUTPUT),
      }),
    ).toEqual({ kind: "not-configured" });
    // Upstream: a mail container that isn't running.
    expect(
      supabaseSelfHostedEmailStatusFrom({
        autoconfirm: false,
        mail: mail(withSmtpHost("supabase-mail")),
      }),
    ).toEqual({ kind: "not-configured" });
  });

  it("reports a configured mail server, including one in the stack", () => {
    expect(
      supabaseSelfHostedEmailStatusFrom({
        autoconfirm: false,
        mail: mail(withSmtpHost("smtp.resend.com")),
      }),
    ).toEqual({ kind: "configured", host: "smtp.resend.com" });
    expect(
      supabaseSelfHostedEmailStatusFrom({
        autoconfirm: false,
        mail: mail(withSmtpHost("supabase-kong")),
      }),
    ).toEqual({ kind: "configured", host: "supabase-kong" });
  });

  it("doesn't guess without the server's settings", () => {
    expect(
      supabaseSelfHostedEmailStatusFrom({ autoconfirm: false, mail: null }),
    ).toEqual({ kind: "unknown" });
    expect(
      supabaseSelfHostedEmailStatusFrom({ autoconfirm: null, mail: null }),
    ).toEqual({ kind: "unknown" });
  });
});

describe("getSupabaseSelfHostedEmailStatus", () => {
  let http: FakeSupabaseSelfHosted | undefined;
  let ssh: FakeEdgeRuntimeSsh | undefined;
  afterEach(async () => {
    closeSupabaseSelfHostedSessions();
    await http?.close();
    await ssh?.close();
    http = undefined;
    ssh = undefined;
  });

  async function instance({ withSsh }: { withSsh: boolean }) {
    http = await startFakeSupabaseSelfHosted("upstream");
    ssh = withSsh ? await startFakeEdgeRuntimeSsh() : undefined;
    return {
      id: "instance-1",
      name: "Home lab",
      url: http.url,
      studioUrl: null,
      anonKey: http.anonKey,
      serviceKey: http.serviceKey,
      ssh: ssh
        ? {
            host: "127.0.0.1",
            port: ssh.port,
            username: "deployer",
            privateKey: generateSshKeyPair().private,
            hostKeyFingerprint: ssh.hostKeyFingerprint,
            functionsContainer: "supabase-edge-functions",
          }
        : null,
    };
  }

  it("reads the server's mail settings over SSH, without its secrets", async () => {
    const target = await instance({ withSsh: true });
    ssh!.mailSettingsOutput = COOLIFY_OUTPUT;

    await expect(getSupabaseSelfHostedEmailStatus(target)).resolves.toEqual({
      kind: "not-configured",
    });
    // Only the two mail variables are let out of the container.
    expect(ssh!.commands[0]).toContain(
      "grep -E '^GOTRUE_(SMTP_HOST|MAILER_AUTOCONFIRM)='",
    );
  });

  it("reads autoconfirm from the instance without SSH", async () => {
    const target = await instance({ withSsh: false });
    http!.mailerAutoconfirm = true;

    await expect(getSupabaseSelfHostedEmailStatus(target)).resolves.toEqual({
      kind: "autoconfirm",
    });
  });

  it("is unknown when neither source can say", async () => {
    const target = await instance({ withSsh: true });
    // No auth container in the functions container's Compose project.
    ssh!.mailSettingsOutput = "";

    await expect(getSupabaseSelfHostedEmailStatus(target)).resolves.toEqual({
      kind: "unknown",
    });
  });
});
