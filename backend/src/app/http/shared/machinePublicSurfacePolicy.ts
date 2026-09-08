import { forbidden } from "../../../shared/domain/errors.js";
import type { AgentInput } from "../../../modules/agents/public.js";

export type MachineAwareRoutePrincipal = {
  type?: string;
} | null | undefined;

const publicLaunchSurfaceError = "Public launch surfaces require an interactive session";

export const isMachinePrincipal = (principal: MachineAwareRoutePrincipal): boolean =>
  principal?.type === "personal_api_credential" || principal?.type === "service_account_credential";

export const rejectMachineLaunchSurfaceInput = (
  principal: MachineAwareRoutePrincipal,
  input: AgentInput,
): void => {
  if (!isMachinePrincipal(principal)) return;
  if (input.surfaceSettings?.anonymousChat !== undefined || input.surfaceSettings?.websiteEmbed !== undefined) {
    throw forbidden(publicLaunchSurfaceError);
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasRawToken = (surface: unknown): boolean =>
  isRecord(surface) && typeof surface.token === "string" && surface.token.length > 0;

/**
 * Bundle imports accept exported placeholder surfaces, because the import
 * projection disables those surfaces before creating the agent. Machine callers
 * still must not author raw public-launch tokens through a crafted bundle.
 */
export const rejectMachineBundlePublicSurfaceSecrets = (
  principal: MachineAwareRoutePrincipal,
  agentConfig: unknown,
): void => {
  if (!isMachinePrincipal(principal) || !isRecord(agentConfig)) return;
  const surfaceSettings = agentConfig.surfaceSettings;
  if (!isRecord(surfaceSettings)) return;
  if (hasRawToken(surfaceSettings.anonymousChat) || hasRawToken(surfaceSettings.websiteEmbed)) {
    throw forbidden(publicLaunchSurfaceError);
  }
};
