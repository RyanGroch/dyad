import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSelfHostedInstances: vi.fn(),
  addSelfHostedInstance: vi.fn(),
  setAppProject: vi.fn(),
  unsetAppProject: vi.fn(),
  removeSelfHostedInstance: vi.fn(),
  openExternalUrl: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    supabase: {
      listSelfHostedInstances: mocks.listSelfHostedInstances,
      addSelfHostedInstance: mocks.addSelfHostedInstance,
      setAppProject: mocks.setAppProject,
      unsetAppProject: mocks.unsetAppProject,
      removeSelfHostedInstance: mocks.removeSelfHostedInstance,
    },
    system: { openExternalUrl: mocks.openExternalUrl },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: mocks.toastSuccess,
    warning: mocks.toastWarning,
    error: mocks.toastError,
  },
}));

import {
  SupabaseSelfHostedConnectedCard,
  SupabaseSelfHostedLinkSection,
} from "./SupabaseSelfHosted";

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(ui, { wrapper });
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

const INSTANCE = {
  id: "instance-1",
  name: "Home lab",
  url: "https://supabase.example.com",
  studioUrl: null as string | null,
  ssh: { host: "203.0.113.5", port: 22, username: "root" } as {
    host: string;
    port: number;
    username: string;
  } | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSelfHostedInstances.mockResolvedValue([]);
  mocks.setAppProject.mockResolvedValue(undefined);
  mocks.unsetAppProject.mockResolvedValue(undefined);
});

describe("SupabaseSelfHostedLinkSection", () => {
  it("adds an instance, shows its warnings, and connects the app to it", async () => {
    mocks.addSelfHostedInstance.mockResolvedValue({
      instance: INSTANCE,
      warnings: ["Auth emails link to an internal host."],
    });
    const onLinked = vi.fn().mockResolvedValue(undefined);
    renderWithQuery(
      <SupabaseSelfHostedLinkSection appId={7} onLinked={onLinked} />,
    );

    fireEvent.click(screen.getByTestId("supabase-self-hosted-add-button"));
    fill("Name", "Home lab");
    fill("API URL", "https://supabase.example.com");
    fill("Anon or publishable key", "sb_publishable_a");
    fill("Service role or secret key", "sb_secret_s");
    fill("SSH user", "root");
    fill("Private key", "-----BEGIN OPENSSH PRIVATE KEY-----");
    fireEvent.click(screen.getByRole("button", { name: "Add and connect" }));

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(mocks.addSelfHostedInstance).toHaveBeenCalledWith({
      name: "Home lab",
      url: "https://supabase.example.com",
      anonKey: "sb_publishable_a",
      serviceKey: "sb_secret_s",
      studioUrl: null,
      // An empty SSH host means the API URL's host.
      ssh: {
        host: "supabase.example.com",
        port: 22,
        username: "root",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
      },
    });
    expect(mocks.setAppProject).toHaveBeenCalledWith({
      appId: 7,
      projectId: "instance-1",
      organizationSlug: null,
    });
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      "Auth emails link to an internal host.",
      expect.anything(),
    );
  });

  it("adds an instance without SSH when the switch is off", async () => {
    mocks.addSelfHostedInstance.mockResolvedValue({
      instance: { ...INSTANCE, ssh: null },
      warnings: [],
    });
    const onLinked = vi.fn().mockResolvedValue(undefined);
    renderWithQuery(
      <SupabaseSelfHostedLinkSection appId={7} onLinked={onLinked} />,
    );

    fireEvent.click(screen.getByTestId("supabase-self-hosted-add-button"));
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.queryByLabelText("Private key")).toBeNull();
    fill("Name", "Home lab");
    fill("API URL", "https://supabase.example.com");
    fill("Anon or publishable key", "sb_publishable_a");
    fill("Service role or secret key", "sb_secret_s");
    fireEvent.click(screen.getByRole("button", { name: "Add and connect" }));

    await waitFor(() => expect(onLinked).toHaveBeenCalled());
    expect(mocks.addSelfHostedInstance).toHaveBeenCalledWith(
      expect.objectContaining({ ssh: null }),
    );
  });

  it("shows a failed check next to the form and does not connect", async () => {
    mocks.addSelfHostedInstance.mockRejectedValue(
      new Error("The instance rejected the service key (401)."),
    );
    renderWithQuery(
      <SupabaseSelfHostedLinkSection appId={7} onLinked={vi.fn()} />,
    );

    fireEvent.click(screen.getByTestId("supabase-self-hosted-add-button"));
    fill("Name", "Home lab");
    fill("API URL", "https://supabase.example.com");
    fill("Anon or publishable key", "sb_publishable_a");
    fill("Service role or secret key", "wrong");
    fill("SSH user", "root");
    fill("Private key", "key");
    fireEvent.click(screen.getByRole("button", { name: "Add and connect" }));

    expect(
      (await screen.findByTestId("supabase-self-hosted-form-error"))
        .textContent,
    ).toContain("rejected the service key");
    expect(mocks.setAppProject).not.toHaveBeenCalled();
  });
});

describe("SupabaseSelfHostedConnectedCard", () => {
  const app = {
    id: 7,
    name: "Shop",
    supabaseSelfHosted: {
      ...INSTANCE,
      studioUrl: "https://studio.example.com",
    },
  } as Parameters<typeof SupabaseSelfHostedConnectedCard>[0]["app"];

  it("opens Studio and disconnects the app", async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    renderWithQuery(
      <SupabaseSelfHostedConnectedCard app={app} onChanged={onChanged} />,
    );

    expect(screen.getByText("Home lab")).toBeTruthy();
    expect(
      screen.getByText(/deploy over SSH as root@203\.0\.113\.5/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Studio/ }));
    expect(mocks.openExternalUrl).toHaveBeenCalledWith(
      "https://studio.example.com",
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Disconnect instance" }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(mocks.unsetAppProject).toHaveBeenCalledWith({ app: 7 });
  });
});
