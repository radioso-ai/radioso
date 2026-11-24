import { buildDashboardHref } from '@/lib/dashboard-routes'

/**
 * Whether Ray's availability reports that the platform's chat model cannot run for the workspace.
 * An availability that has not loaded yet is not "missing", so a setup prompt never flashes.
 */
export const isLlmMissing = (availability: { reason: 'ok' | 'no_llm_capability' } | null | undefined): boolean =>
  availability?.reason === 'no_llm_capability'


/** Where an operator configures a chat model provider for the workspace. */
export const buildProviderSettingsHref = (
  accountId: string,
  workspace: { workspaceId?: string; workspacePublicRouteKey?: string },
): string => buildDashboardHref(accountId, { section: 'settings', settingsTab: 'providers', ...workspace })
