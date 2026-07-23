import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ipc,
  vpsEventClient,
  type VpsDeployConfig,
  type VpsDeploySnapshot,
} from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";

const IDLE_SNAPSHOT: VpsDeploySnapshot = {
  status: "idle",
  stage: null,
  error: null,
  log: "",
  url: null,
  startedAt: null,
  finishedAt: null,
};

export function useVpsDeploy(appId: number | null) {
  const queryClient = useQueryClient();
  const [snapshot, setSnapshot] = useState<VpsDeploySnapshot>(IDLE_SNAPSHOT);

  const {
    data: status,
    isLoading: isStatusLoading,
    refetch: refetchStatus,
  } = useQuery({
    queryKey: queryKeys.vps.status({ appId: appId ?? -1 }),
    queryFn: async () => ipc.vps.getStatus({ appId: appId! }),
    enabled: appId !== null,
  });

  // The main process owns deploy state; re-fetch on mount so a reload
  // mid-deploy rehydrates, then follow pushed updates.
  useEffect(() => {
    if (appId === null) return;
    let disposed = false;
    void ipc.vps.getDeploySnapshot({ appId }).then((current) => {
      if (!disposed) setSnapshot(current);
    });
    const unsubscribe = vpsEventClient.onDeployStatus((payload) => {
      if (payload.appId === appId) setSnapshot(payload.snapshot);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [appId]);

  const invalidateStatus = () => {
    if (appId !== null) {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.vps.status({ appId }),
      });
    }
  };

  const generateKeyMutation = useMutation({
    mutationFn: async () => ipc.vps.generateKey(),
    onSuccess: invalidateStatus,
  });

  const testConnectionMutation = useMutation({
    mutationFn: async (config: VpsDeployConfig) =>
      ipc.vps.testConnection({ config }),
  });

  const saveConfigMutation = useMutation({
    mutationFn: async (config: VpsDeployConfig) =>
      ipc.vps.saveConfig({ appId: appId!, config }),
    onSuccess: invalidateStatus,
  });

  const scaffoldMutation = useMutation({
    mutationFn: async () => ipc.vps.scaffold({ appId: appId! }),
    onSuccess: invalidateStatus,
  });

  const deployMutation = useMutation({
    mutationFn: async () => ipc.vps.deploy({ appId: appId! }),
  });

  const cancelMutation = useMutation({
    mutationFn: async () => ipc.vps.cancelDeploy({ appId: appId! }),
  });

  return {
    status: status ?? null,
    isStatusLoading,
    refetchStatus,
    snapshot,
    generateKey: generateKeyMutation.mutateAsync,
    isGeneratingKey: generateKeyMutation.isPending,
    testConnection: testConnectionMutation.mutateAsync,
    isTestingConnection: testConnectionMutation.isPending,
    testResult: testConnectionMutation.data ?? null,
    saveConfig: saveConfigMutation.mutateAsync,
    isSavingConfig: saveConfigMutation.isPending,
    scaffold: scaffoldMutation.mutateAsync,
    isScaffolding: scaffoldMutation.isPending,
    deploy: deployMutation.mutateAsync,
    cancelDeploy: cancelMutation.mutateAsync,
  };
}
