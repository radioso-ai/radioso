/** What a composed application holds open past its last request, as the API runtime and the eval runner close it. */
export interface ClosableDependencies {
  realtimePublisherLifecycle: { shutdown(): Promise<void> };
  applicationModules: { shutdownAll(): Promise<void> };
  closeApprovalResumeEffectJournal(): Promise<void>;
  closeAbuseControlRepository?(): Promise<void>;
  connectorRegistry: { shutdownAll(): Promise<void> };
}

/**
 * Closes what `buildDependencies` opened, in the order the API runtime shuts down: the realtime
 * publisher (its Redis connection, when it has one), the application modules, the approval
 * journal's database, the abuse-control repository, then the connectors. Each step runs even when
 * one before it fails, and the failure propagates. The main database pool stays open for the
 * caller, which ends it or exits.
 */
export const closeDependencies = async (dependencies: ClosableDependencies): Promise<void> => {
  try {
    await dependencies.realtimePublisherLifecycle.shutdown();
  } finally {
    try {
      try {
        await dependencies.applicationModules.shutdownAll();
      } finally {
        try {
          await dependencies.closeApprovalResumeEffectJournal();
        } finally {
          await dependencies.closeAbuseControlRepository?.();
        }
      }
    } finally {
      await dependencies.connectorRegistry.shutdownAll();
    }
  }
};
