import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Database, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/types";
import { useLoadApp } from "@/hooks/useLoadApp";
import { useNeon } from "@/hooks/useNeon";
import { useSettings } from "@/hooks/useSettings";
import {
  cancelConnectionFlow,
  startConnectionFlow,
  useConnectionFlow,
} from "@/hooks/useConnectionFlow";
import { getErrorMessage } from "@/lib/errors";

/**
 * Sets an app up on standard Postgres.
 *
 * The development database is a Neon project — that is what makes setup
 * one click — but the app is marked for portable code generation, so the
 * model writes a plain `pg` client against DATABASE_URL rather than anything
 * Neon-specific. That is what lets the same app run against a database the
 * user hosts themselves.
 */
export function PostgresConnector({ appId }: { appId: number }) {
  const { app, refreshApp } = useLoadApp(appId);
  const { isConnected, projectInfo } = useNeon(appId);
  const { settings } = useSettings();
  const { isFlowActive } = useConnectionFlow("neon");
  const queryClient = useQueryClient();
  const [isProvisioning, setIsProvisioning] = useState(false);

  const isPortable = Boolean(app?.portableCodegen);
  const hasProject = Boolean(app?.neonProjectId);

  const setPortable = useMutation({
    mutationFn: (enabled: boolean) =>
      ipc.coolify.setPortableCodegen({ appId, enabled }),
    onSuccess: () => refreshApp(),
  });

  // Signing in and creating the database are one action from the user's point
  // of view, so keep them together behind a single button.
  const handleSetUp = async () => {
    try {
      if (!isConnected) {
        const { started, flowId } = await startConnectionFlow("neon");
        if (!started) return;
        try {
          if (settings?.isTestMode) {
            await ipc.neon.fakeConnect();
          } else {
            await ipc.system.openExternalUrl(
              "https://oauth.dyad.sh/api/integrations/neon/login",
            );
          }
        } catch (error) {
          await cancelConnectionFlow("neon", flowId);
          throw error;
        }
        // The rest happens once the user returns and the flow completes; they
        // press the button again to provision.
        return;
      }

      setIsProvisioning(true);
      // Read the app fresh rather than trusting what this component last
      // loaded: signing in through the Neon flow can create the project, and
      // acting on a stale copy means asking to create a second one, which is
      // refused with a message about disconnecting.
      const current = await ipc.app.getApp(appId);
      // A Postgres app is Neon-backed in development, so an app that already
      // has a project just switches to portable code generation and keeps its
      // database.
      if (!current.neonProjectId) {
        const project = await ipc.neon.createProject({
          name: app?.name ?? `dyad-app-${appId}`,
          appId,
        });
        await ipc.neon.setAppProject({ appId, projectId: project.id });
        if (project.warning) toast.warning(project.warning);
      }
      await setPortable.mutateAsync(true);
      await queryClient.invalidateQueries();
      toast.success("Postgres is set up for this app");
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsProvisioning(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      // Only stop generating portable code. The database is the app's Neon
      // project; removing it here would be a surprising amount of destruction.
      await setPortable.mutateAsync(false);
      await queryClient.invalidateQueries();
      toast.success("Switched back to Neon-specific code");
    } catch (error) {
      toast.error(getErrorMessage(error));
    }
  };

  if (isPortable && hasProject) {
    return (
      <Card className="mt-1" data-testid="postgres-connector">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <CardTitle className="flex flex-wrap items-center gap-2">
                <Database size={18} className="text-muted-foreground" />
                <span>Postgres</span>
                <Badge
                  variant="secondary"
                  className="max-w-full truncate px-3 py-1 text-base font-bold"
                >
                  {projectInfo?.projectName ?? app?.neonProjectId}
                </Badge>
              </CardTitle>
              <CardDescription className="text-sm">
                Standard Postgres. Your development database is hosted by Neon;
                production can run anywhere, including a server you own.
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={handleDisconnect}>
              Disconnect
            </Button>
          </div>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className="mt-1" data-testid="postgres-connector">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database size={18} className="text-muted-foreground" />
          Postgres
        </CardTitle>
        <CardDescription>
          A plain Postgres database, with no vendor-specific features. Your
          development database is hosted by Neon so setup stays one click, and
          because the generated code is standard Postgres, production can run
          anywhere — including a server you own. Choose this to let Coolify host
          this app's database.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button
          onClick={handleSetUp}
          disabled={isFlowActive || isProvisioning}
          data-testid="setup-postgres-button"
        >
          {(isFlowActive || isProvisioning) && (
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
          )}
          {isConnected ? "Set up Postgres" : "Sign in to continue"}
          {!isConnected && <ExternalLink className="h-4 w-4 ml-2" />}
        </Button>
        {isFlowActive && (
          <p className="text-xs text-muted-foreground">
            Finish signing in in your browser, then press the button again.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
