import { appPortFailure, type AppPortResult } from "../domain/portOutcome.js";

/**
 * Names the one step of one operation this call belongs to. Every implementation MUST
 * deduplicate on it: a crash between an external effect landing and its cursor advancing
 * is normal, so the same `(operationId, stepId)` pair can arrive more than once and must
 * produce the same single effect.
 */
export interface AppLifecycleEffect {
  readonly operationId: string;
  readonly stepId: string;
}

/** What a provider needs to start an installation, and nothing else. */
export interface AppRuntimeProvisioningRequest {
  readonly effect: AppLifecycleEffect;
  readonly installationId: string;
  readonly workspaceId: string;
  readonly release: {
    /** The admitted manifest digest, which is what pins what may run. */
    readonly digest: string;
    readonly artifact: {
      readonly digest: string;
      readonly mediaType: string;
      /** `null` when the artifact's own media type defines it. */
      readonly entrypoint: string | null;
    };
    readonly resourceProfile: {
      readonly memoryMb: number;
      readonly cpuMillis: number;
      readonly maxConcurrentInvocations: number;
      readonly scratchMb: number;
    };
  };
}

export interface AppRuntimeDeprovisioningRequest {
  readonly effect: AppLifecycleEffect;
  readonly installationId: string;
}

/**
 * How an installation's App process comes into existence. The Apps domain knows only
 * this shape; the local-process provider, and later a sandbox provider, live behind it.
 * A provider reports refusal as a typed code — never as an exception message, which
 * could carry a token, a command line, or a response body.
 */
export interface AppRuntimeProvisioningPort {
  provision(request: AppRuntimeProvisioningRequest): Promise<AppPortResult>;
  deprovision(request: AppRuntimeDeprovisioningRequest): Promise<AppPortResult>;
}

/**
 * The default when no runtime provider is configured. Radioso must build and run with
 * the hosted App runtime absent (FR-075), so this refuses the one step that needs a
 * runtime with a reason an operator can act on, rather than the platform refusing to
 * start or an installation hanging in `provisioning`.
 */
export const createUnavailableAppRuntimeProvisioning = (): AppRuntimeProvisioningPort => ({
  provision: async () => appPortFailure("runtime_unavailable"),
  deprovision: async () => ({ ok: true }),
});
