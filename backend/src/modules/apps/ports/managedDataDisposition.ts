export const appDataDispositions = ["export", "retain", "delete"] as const;
export type AppDataDisposition = (typeof appDataDispositions)[number];

export interface AppManagedDataDispositionRequest {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly disposition: AppDataDisposition;
}

/** What happens to an installation's managed records when it is removed. */
export interface AppManagedDataDispositionPort {
  dispose(request: AppManagedDataDispositionRequest): Promise<void>;
}

/** Release A default: managed collections arrive with `appStorage`, so there is nothing to dispose. */
export const createNoopAppManagedDataDisposition = (): AppManagedDataDispositionPort => ({
  dispose: async () => {},
});
