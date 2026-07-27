import { useEffect, useState } from "react";
import { Copy, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCoolifyDeploy } from "@/hooks/useCoolifyDeploy";
import { getErrorMessage } from "@/lib/errors";

interface CoolifyConnectorProps {
  appId: number | null;
  hasGithubRepo: boolean;
}

const STAGE_LABELS: Record<string, string> = {
  preflight: "Checking access",
  push: "Pushing code",
  "provision-database": "Provisioning database",
  migrate: "Migrating schema",
  "create-application": "Creating application",
  deploy: "Deploying",
  finalize: "Finishing",
};

export function CoolifyConnector({
  appId,
  hasGithubRepo,
}: CoolifyConnectorProps) {
  const {
    status,
    isStatusLoading,
    snapshot,
    discovery,
    discoveryError,
    refetchDiscovery,
    createProject,
    isCreatingProject,
    saveToken,
    isSavingToken,
    generateSshKey,
    isGeneratingSshKey,
    testSsh,
    isTestingSsh,
    sshTestResult,
    saveConnection,
    isSavingConnection,
    deploy,
    disconnect,
  } = useCoolifyDeploy(appId);

  const [instanceUrl, setInstanceUrl] = useState("");
  const [token, setToken] = useState("");
  const [serverUuid, setServerUuid] = useState("");
  const [projectUuid, setProjectUuid] = useState("");
  const [sshHost, setSshHost] = useState("");
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState("22");
  const [provisionDatabase, setProvisionDatabase] = useState(true);

  useEffect(() => {
    const c = status?.connection;
    if (c) {
      setInstanceUrl(c.instanceUrl);
      setServerUuid(c.serverUuid);
      setProjectUuid(c.projectUuid);
      setSshHost(c.sshHost);
      setSshUser(c.sshUser);
      setSshPort(String(c.sshPort));
    }
  }, [status?.connection]);

  if (appId === null || isStatusLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading...
      </div>
    );
  }
  if (!status) return null;

  if (!status.sshAvailable) {
    return (
      <p className="text-sm text-muted-foreground">
        Deploying with Coolify needs the OpenSSH client, which was not found on
        this machine.
      </p>
    );
  }

  const isDeploying = snapshot.status === "running";

  // --- Step 1: instance URL + API token ---
  if (!status.hasToken) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Install Coolify on your server, then create an API token under Keys
          &amp; Tokens. It needs the <code>read</code>,{" "}
          <code>read:sensitive</code>, <code>write</code>, and{" "}
          <code>deploy</code> scopes.
        </p>
        <div>
          <Label htmlFor="coolify-url">Coolify URL</Label>
          <Input
            id="coolify-url"
            placeholder="http://203.0.113.7:8000"
            value={instanceUrl}
            onChange={(e) => setInstanceUrl(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="coolify-token">API token</Label>
          <Input
            id="coolify-token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          disabled={isSavingToken || !instanceUrl.trim() || !token.trim()}
          onClick={async () => {
            try {
              await saveToken({ instanceUrl: instanceUrl.trim(), token });
              setToken("");
              toast.success("Connected to Coolify");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          {isSavingToken && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
          Connect
        </Button>
      </div>
    );
  }

  // --- Step 2: server, project, and SSH access ---
  if (!status.connection) {
    return (
      <div className="space-y-3">
        {!status.sshKeyExists ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Dyad needs SSH access to your server to reach the database when
              applying schema changes. This is separate from the API token.
            </p>
            <Button
              size="sm"
              onClick={() => generateSshKey()}
              disabled={isGeneratingSshKey}
            >
              {isGeneratingSshKey && (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              )}
              Generate SSH key
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Add this key to your server</Label>
            <p className="text-xs text-muted-foreground">
              Append it to <code>~/.ssh/authorized_keys</code> on the server.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
                {status.sshPublicKey}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(
                    status.sshPublicKey ?? "",
                  );
                  toast.success("Public key copied");
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {discoveryError && (
          <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
            <p className="font-medium">Could not load servers and projects</p>
            <p className="mt-1">{getErrorMessage(discoveryError)}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => refetchDiscovery()}
            >
              Retry
            </Button>
          </div>
        )}

        {!discoveryError && discovery && discovery.projects.length === 0 && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <p>
              This Coolify instance has no projects yet. Create one to deploy
              into.
            </p>
            <Button
              size="sm"
              className="mt-2"
              disabled={isCreatingProject}
              onClick={async () => {
                try {
                  const project = await createProject("dyad");
                  setProjectUuid(project.uuid);
                  toast.success("Project created");
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : String(err));
                }
              }}
            >
              {isCreatingProject && (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              )}
              Create a project
            </Button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Server</Label>
            <Select
              value={serverUuid}
              onValueChange={(v) => setServerUuid(v ?? "")}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a server" />
              </SelectTrigger>
              <SelectContent>
                {(discovery?.servers ?? []).map((s) => (
                  <SelectItem key={s.uuid} value={s.uuid}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Project</Label>
            <Select
              value={projectUuid}
              onValueChange={(v) => setProjectUuid(v ?? "")}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a project" />
              </SelectTrigger>
              <SelectContent>
                {(discovery?.projects ?? []).map((p) => (
                  <SelectItem key={p.uuid} value={p.uuid}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="coolify-ssh-host">Server address (SSH)</Label>
            <Input
              id="coolify-ssh-host"
              placeholder="203.0.113.7"
              value={sshHost}
              onChange={(e) => setSshHost(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="coolify-ssh-user">SSH user</Label>
            <Input
              id="coolify-ssh-user"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="coolify-ssh-port">SSH port</Label>
            <Input
              id="coolify-ssh-port"
              value={sshPort}
              onChange={(e) => setSshPort(e.target.value)}
            />
          </div>
        </div>

        {sshTestResult && !sshTestResult.ok && (
          <p className="text-sm text-red-600 dark:text-red-400">
            {sshTestResult.error}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isTestingSsh || !sshHost.trim()}
            onClick={async () => {
              const result = await testSsh({
                sshHost: sshHost.trim(),
                sshUser: sshUser.trim(),
                sshPort: Number(sshPort) || 22,
              });
              if (result.ok) toast.success("SSH connection OK");
            }}
          >
            {isTestingSsh && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Test SSH
          </Button>
          <Button
            size="sm"
            disabled={
              isSavingConnection ||
              !serverUuid ||
              !projectUuid ||
              !sshHost.trim()
            }
            onClick={async () => {
              try {
                await saveConnection({
                  instanceUrl,
                  serverUuid,
                  projectUuid,
                  environmentName: "production",
                  sshHost: sshHost.trim(),
                  sshUser: sshUser.trim(),
                  sshPort: Number(sshPort) || 22,
                });
                toast.success("Server connected");
              } catch (err) {
                toast.error(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  // --- Step 3: deploy ---
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="font-medium">
            {status.connection.sshUser}@{status.connection.sshHost}
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={() => disconnect()}>
          Disconnect
        </Button>
      </div>

      {!hasGithubRepo && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Coolify deploys from a git repository. Connect this app to GitHub
          above first.
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={provisionDatabase}
          onCheckedChange={(v) => setProvisionDatabase(v === true)}
        />
        Let Coolify host a Postgres database for this app
      </label>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={isDeploying || !hasGithubRepo}
          onClick={async () => {
            try {
              await deploy(provisionDatabase);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          {isDeploying ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              {STAGE_LABELS[snapshot.stage ?? ""] ?? "Deploying"}
            </>
          ) : (
            <>
              <RefreshCw className="h-4 w-4 mr-2" />
              Deploy
            </>
          )}
        </Button>
      </div>

      {snapshot.status === "succeeded" && snapshot.url && (
        <p className="text-sm text-green-700 dark:text-green-400">
          Deployed:{" "}
          <a
            href={snapshot.url}
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            {snapshot.url}
          </a>
        </p>
      )}
      {snapshot.status === "failed" && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {snapshot.error}
        </p>
      )}
      {snapshot.log && (
        <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
          {snapshot.log}
        </pre>
      )}
    </div>
  );
}
