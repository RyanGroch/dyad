import { useEffect, useState } from "react";
import { Loader2, Copy, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  type VpsDeployConfig,
  type VpsTestConnectionResult,
} from "@/ipc/types";
import { useVpsDeploy } from "@/hooks/useVpsDeploy";

interface VpsConnectorProps {
  appId: number | null;
  folderName: string;
}

const ERROR_HINTS: Record<string, string> = {
  unreachable:
    "The server could not be reached. Check the IP address and that the server is running.",
  "auth-rejected":
    "The server refused the key. Make sure the public key above is added to the server (in your provider's console or ~/.ssh/authorized_keys).",
  "host-key-changed":
    "The server's identity changed since the last connection. If you rebuilt the server this is expected; remove the old entry from ~/.ssh/known_hosts and retry.",
  timeout: "The connection timed out. Check the address, port, and firewall.",
  "ssh-missing": "OpenSSH was not found on this machine.",
};

function connectionHint(result: VpsTestConnectionResult): string {
  return (
    (result.errorKind && ERROR_HINTS[result.errorKind]) ||
    result.error ||
    "Connection failed."
  );
}

const STAGE_LABELS: Record<string, string> = {
  preflight: "Checking connection",
  build: "Building",
  upload: "Uploading",
  "remote-setup": "Setting up server",
  "remote-deploy": "Publishing release",
  finalize: "Finishing",
};

export function VpsConnector({ appId, folderName }: VpsConnectorProps) {
  const {
    status,
    isStatusLoading,
    snapshot,
    generateKey,
    isGeneratingKey,
    testConnection,
    isTestingConnection,
    testResult,
    saveConfig,
    isSavingConfig,
    scaffold,
    isScaffolding,
    deploy,
    cancelDeploy,
  } = useVpsDeploy(appId);

  const [isEditing, setIsEditing] = useState(false);
  const [host, setHost] = useState("");
  const [user, setUser] = useState("root");
  const [port, setPort] = useState("22");
  const [domain, setDomain] = useState("");

  useEffect(() => {
    if (status?.config) {
      setHost(status.config.host);
      setUser(status.config.user);
      setPort(String(status.config.port));
      setDomain(status.config.domain ?? "");
    }
  }, [status?.config]);

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
        Deploying to your own server requires the OpenSSH client, which was not
        found on this machine.
      </p>
    );
  }

  const buildConfig = (): VpsDeployConfig | null => {
    const parsedPort = Number(port);
    if (!host.trim() || !user.trim() || !Number.isInteger(parsedPort)) {
      toast.error("Enter the server address, user, and port");
      return null;
    }
    return {
      host: host.trim(),
      user: user.trim(),
      port: parsedPort,
      remotePath:
        status.config?.remotePath ?? `/var/www/${folderName || "app"}`,
      domain: domain.trim() ? domain.trim() : null,
      keyName: status.config?.keyName ?? "dyad_deploy_ed25519",
      distDir: status.config?.distDir ?? status.compat.recommendedDistDir,
    };
  };

  const handleCopyKey = async () => {
    if (!status.publicKey) return;
    await navigator.clipboard.writeText(status.publicKey);
    toast.success("Public key copied");
  };

  const handleTest = async () => {
    const config = buildConfig();
    if (!config) return;
    const result = await testConnection(config);
    if (result.ok) {
      toast.success("Connected to server");
    }
  };

  const handleSave = async () => {
    const config = buildConfig();
    if (!config) return;
    try {
      await saveConfig(config);
      setIsEditing(false);
      toast.success("Server connection saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleScaffold = async () => {
    try {
      const result = await scaffold();
      toast.success(
        result.written.length > 0
          ? `Created ${result.written.length} deploy file(s)`
          : "Deploy files already exist",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeploy = async () => {
    try {
      await deploy();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const isDeployActive =
    snapshot.status === "preflight" || snapshot.status === "running";

  const keySection = !status.keyExists ? (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Dyad uses a dedicated SSH key to connect to your server. Generate one to
        get started.
      </p>
      <Button
        size="sm"
        onClick={() => generateKey()}
        disabled={isGeneratingKey}
      >
        {isGeneratingKey && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
        Generate deploy key
      </Button>
    </div>
  ) : (
    <div className="space-y-2">
      <Label>Your deploy key</Label>
      <p className="text-xs text-muted-foreground">
        Add this public key to your server: paste it into your provider's SSH
        key field, or append it to ~/.ssh/authorized_keys on the server.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">
          {status.publicKey}
        </code>
        <Button variant="outline" size="sm" onClick={handleCopyKey}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );

  const connectionForm = (
    <div className="space-y-3">
      {keySection}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label htmlFor="vps-host">Server address</Label>
          <Input
            id="vps-host"
            placeholder="203.0.113.7"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="vps-user">User</Label>
          <Input
            id="vps-user"
            value={user}
            onChange={(e) => setUser(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="vps-port">Port</Label>
          <Input
            id="vps-port"
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="vps-domain">Domain (optional)</Label>
          <Input
            id="vps-domain"
            placeholder="myapp.example.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
        </div>
      </div>
      {testResult && !testResult.ok && (
        <p className="text-sm text-red-600 dark:text-red-400">
          {connectionHint(testResult)}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={isTestingConnection || !status.keyExists}
        >
          {isTestingConnection && (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          )}
          Test connection
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={isSavingConfig || !status.keyExists}
        >
          Save
        </Button>
        {status.config && (
          <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );

  if (!status.config || isEditing) {
    return connectionForm;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-sm">
          <span className="font-medium">
            {status.config.user}@{status.config.host}
          </span>
          {status.config.domain && (
            <span className="text-muted-foreground">
              {" "}
              → {status.config.domain}
            </span>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={() => setIsEditing(true)}>
          Edit
        </Button>
      </div>

      {!status.compat.supported && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">This app can't be deployed to a VPS yet</p>
          {status.compat.blockers.map((blocker) => (
            <p key={blocker} className="mt-1">
              {blocker}
            </p>
          ))}
        </div>
      )}

      {status.compat.supported && status.compat.notes.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {status.compat.notes.join(" ")}
        </p>
      )}

      {!status.compat.supported ? null : !status.scaffoldPresent ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Dyad will add deploy scripts to your app. They run with{" "}
            <code>npm run deploy</code> and work for static builds on a fresh
            Ubuntu or Debian server.
          </p>
          <Button size="sm" onClick={handleScaffold} disabled={isScaffolding}>
            {isScaffolding && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Generate deploy files
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleDeploy} disabled={isDeployActive}>
              {isDeployActive ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  {STAGE_LABELS[snapshot.stage ?? "preflight"] ?? "Deploying"}
                </>
              ) : (
                <>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Deploy
                </>
              )}
            </Button>
            {isDeployActive && (
              <Button variant="ghost" size="sm" onClick={() => cancelDeploy()}>
                Cancel
              </Button>
            )}
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
              Deploy failed
              {snapshot.stage
                ? ` while ${STAGE_LABELS[snapshot.stage]?.toLowerCase() ?? snapshot.stage}`
                : ""}
              : {snapshot.error}
            </p>
          )}

          {snapshot.log && (
            <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
              {snapshot.log}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
