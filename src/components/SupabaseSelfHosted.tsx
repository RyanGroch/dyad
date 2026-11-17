import { useState } from "react";
import { ExternalLink, Info, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ipc, type App } from "@/ipc/types";
import { getErrorMessage } from "@/lib/errors";
import {
  useAddSupabaseSelfHostedInstance,
  useRemoveSupabaseSelfHostedInstance,
  useSupabaseSelfHostedInstances,
} from "@/hooks/useSupabaseSelfHosted";

// Experimental UI: English only, like the other experiment surfaces.

const NO_SSH_NOTE =
  "Edge functions aren't deployed to this instance because it was added without SSH access. Dyad keeps their code in supabase/functions.";

function functionsNote(ssh: NonNullable<App["supabaseSelfHosted"]>["ssh"]) {
  if (!ssh) return NO_SSH_NOTE;
  return `Edge functions deploy over SSH as ${ssh.username}@${ssh.host}. After an update, the previous version can keep answering for up to a minute after its last request, or a few minutes under steady traffic.`;
}

/** The API URL's host, which is usually the server to SSH into. */
function hostOf(url: string): string {
  try {
    return new URL(url.trim()).hostname;
  } catch {
    return "";
  }
}

async function linkApp(appId: number, projectId: string) {
  await ipc.supabase.setAppProject({
    appId,
    projectId,
    organizationSlug: null,
  });
}

/** Shown in place of the Cloud connector when the app uses a self-hosted instance. */
export function SupabaseSelfHostedConnectedCard({
  app,
  onChanged,
}: {
  app: App & { supabaseSelfHosted: NonNullable<App["supabaseSelfHosted"]> };
  onChanged: () => Promise<unknown>;
}) {
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const instance = app.supabaseSelfHosted;

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    try {
      await ipc.supabase.unsetAppProject({ app: app.id });
      toast.success("Disconnected the self-hosted Supabase instance");
      await onChanged();
    } catch (error) {
      toast.error(`Failed to disconnect: ${getErrorMessage(error)}`);
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <Card
      key="supabase-self-hosted-connected"
      className="mt-1"
      data-testid="supabase-self-hosted-connected-card"
    >
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Supabase (self-hosted)
          {instance.studioUrl && (
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => ipc.system.openExternalUrl(instance.studioUrl!)}
            >
              Studio
              <ExternalLink className="h-4 w-4" />
            </Button>
          )}
        </CardTitle>
        <CardDescription className="flex flex-col gap-1.5 text-sm">
          Connected to instance
          <Badge variant="secondary" className="w-fit text-base font-bold">
            {instance.name}
          </Badge>
          <span className="break-all text-xs">{instance.url}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription>{functionsNote(instance.ssh)}</AlertDescription>
        </Alert>
        <Button
          variant="destructive"
          onClick={handleDisconnect}
          disabled={isDisconnecting}
        >
          Disconnect instance
        </Button>
      </CardContent>
    </Card>
  );
}

const EMPTY_FORM = {
  name: "",
  url: "",
  anonKey: "",
  serviceKey: "",
  studioUrl: "",
  sshHost: "",
  sshPort: "22",
  sshUsername: "",
  sshPrivateKey: "",
};

/** Lets an unlinked app connect to an existing or new self-hosted instance. */
export function SupabaseSelfHostedLinkSection({
  appId,
  onLinked,
}: {
  appId: number;
  onLinked: () => Promise<unknown>;
}) {
  const instancesQuery = useSupabaseSelfHostedInstances({ enabled: true });
  const addInstance = useAddSupabaseSelfHostedInstance();
  const instances = instancesQuery.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLinking, setIsLinking] = useState(false);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [useSsh, setUseSsh] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  const link = async (projectId: string) => {
    setIsLinking(true);
    try {
      await linkApp(appId, projectId);
      toast.success("Connected to the self-hosted Supabase instance");
      await onLinked();
    } catch (error) {
      toast.error(`Failed to connect: ${getErrorMessage(error)}`);
    } finally {
      setIsLinking(false);
    }
  };

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    setFormError(null);
    const sshPort = Number(form.sshPort);
    if (
      useSsh &&
      !(Number.isInteger(sshPort) && sshPort > 0 && sshPort < 65536)
    ) {
      setFormError("Enter an SSH port between 1 and 65535.");
      return;
    }
    try {
      const { instance, warnings } = await addInstance.mutateAsync({
        name: form.name,
        url: form.url,
        anonKey: form.anonKey,
        serviceKey: form.serviceKey,
        studioUrl: form.studioUrl.trim() || null,
        ssh: useSsh
          ? {
              host: form.sshHost.trim() || hostOf(form.url),
              port: sshPort,
              username: form.sshUsername,
              privateKey: form.sshPrivateKey,
            }
          : null,
      });
      for (const warning of warnings) {
        toast.warning(warning, { duration: 20_000 });
      }
      setForm(EMPTY_FORM);
      setIsFormOpen(false);
      await link(instance.id);
    } catch (error) {
      setFormError(getErrorMessage(error));
    }
  };

  const field = (
    key: keyof typeof EMPTY_FORM,
    label: string,
    options: { placeholder?: string; secret?: boolean; optional?: boolean },
  ) => (
    <div className="space-y-1">
      <Label htmlFor={`supabase-self-hosted-${key}`}>{label}</Label>
      <Input
        id={`supabase-self-hosted-${key}`}
        type={options.secret ? "password" : "text"}
        autoComplete="off"
        placeholder={options.placeholder}
        required={!options.optional}
        value={form[key]}
        onChange={(event) => {
          setForm((current) => ({ ...current, [key]: event.target.value }));
          setFormError(null);
        }}
      />
    </div>
  );

  return (
    <Card className="mt-3" data-testid="supabase-self-hosted-link-section">
      <CardHeader>
        <CardTitle>Self-hosted Supabase</CardTitle>
        <CardDescription>
          Connect this app to a Supabase instance you run yourself, such as one
          deployed with Docker Compose or Coolify.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {instances.length > 0 && (
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <Label htmlFor="supabase-self-hosted-select">Instance</Label>
              <Select
                value={selectedId ?? ""}
                onValueChange={(value) => setSelectedId(value || null)}
              >
                <SelectTrigger id="supabase-self-hosted-select">
                  <SelectValue>
                    {(value) =>
                      instances.find((instance) => instance.id === value)
                        ?.name ?? "Select an instance"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {instances.map((instance) => (
                    <SelectItem key={instance.id} value={instance.id}>
                      {instance.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              onClick={() => selectedId && link(selectedId)}
              disabled={!selectedId || isLinking}
            >
              Connect
            </Button>
          </div>
        )}

        {isFormOpen ? (
          <form className="space-y-3" onSubmit={handleAdd}>
            {field("name", "Name", { placeholder: "My Supabase" })}
            {field("url", "API URL", {
              placeholder: "https://supabase.example.com",
            })}
            {field("anonKey", "Anon or publishable key", { secret: true })}
            {field("serviceKey", "Service role or secret key", {
              secret: true,
            })}
            {field("studioUrl", "Studio URL (optional)", { optional: true })}
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Switch
                  id="supabase-self-hosted-use-ssh"
                  checked={useSsh}
                  onCheckedChange={setUseSsh}
                />
                <Label htmlFor="supabase-self-hosted-use-ssh">
                  Deploy edge functions over SSH
                </Label>
              </div>
              {useSsh ? (
                <>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      {field("sshHost", "SSH host", {
                        placeholder: hostOf(form.url) || "supabase.example.com",
                        optional: true,
                      })}
                    </div>
                    <div className="w-24">{field("sshPort", "Port", {})}</div>
                  </div>
                  {field("sshUsername", "SSH user", { placeholder: "root" })}
                  <div className="space-y-1">
                    <Label htmlFor="supabase-self-hosted-sshPrivateKey">
                      Private key
                    </Label>
                    <Textarea
                      id="supabase-self-hosted-sshPrivateKey"
                      required
                      rows={4}
                      className="font-mono text-xs"
                      placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                      value={form.sshPrivateKey}
                      onChange={(event) => {
                        setForm((current) => ({
                          ...current,
                          sshPrivateKey: event.target.value,
                        }));
                        setFormError(null);
                      }}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    The user must be able to run docker: root, or a member of
                    the docker group. Use an OpenSSH key without a passphrase.
                    Dyad deploys a short-lived test function to find the
                    instance&apos;s functions container.
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{NO_SSH_NOTE}</p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Dyad checks the instance before saving. The service key stays on
              this computer and is never added to your app&apos;s code. Email
              sign-up in your app needs SMTP configured on the instance.
            </p>
            {formError && (
              <Alert
                variant="destructive"
                data-testid="supabase-self-hosted-form-error"
              >
                <Info className="h-4 w-4" />
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={addInstance.isPending}>
                {addInstance.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {addInstance.isPending
                  ? "Checking instance"
                  : "Add and connect"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setIsFormOpen(false);
                  setFormError(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="gap-1"
            onClick={() => setIsFormOpen(true)}
            data-testid="supabase-self-hosted-add-button"
          >
            <Plus className="h-4 w-4" />
            Add self-hosted instance
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Settings list of saved instances, for removing ones no longer needed. */
export function SupabaseSelfHostedInstancesSettings() {
  const instancesQuery = useSupabaseSelfHostedInstances({ enabled: true });
  const removeInstance = useRemoveSupabaseSelfHostedInstance();
  const instances = instancesQuery.data ?? [];

  if (instances.length === 0) return null;

  return (
    <div data-testid="supabase-self-hosted-settings">
      <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
        Self-hosted Supabase
      </h3>
      <div className="mt-3 space-y-1">
        {instances.map((instance) => (
          <div
            key={instance.id}
            className="flex items-center justify-between gap-2 rounded-md bg-muted/50 p-2 text-sm"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="truncate font-medium">{instance.name}</span>
              <span className="truncate text-xs text-muted-foreground">
                {instance.url}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {instance.ssh
                  ? `Functions over SSH as ${instance.ssh.username}@${instance.ssh.host}`
                  : "No SSH: functions not deployed"}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 shrink-0 px-2 text-muted-foreground hover:text-destructive"
              disabled={removeInstance.isPending}
              onClick={() =>
                removeInstance.mutate(instance.id, {
                  onSuccess: () => toast.success(`Removed ${instance.name}`),
                })
              }
            >
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              <span className="text-xs">Remove</span>
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
