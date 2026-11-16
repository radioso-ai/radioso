import { buildDashboardHref } from '@/lib/dashboard-routes'

/**
 * Whether the workspace can make chat model calls, as either signal reports it: Ray's availability
 * (`reason`) or the workspace summary (`llmConfigured`). The backend derives both from the same
 * check. A status that has not loaded yet is not "missing", so a setup prompt never flashes.
 */
type LlmReadinessSignal =
  | { reason: 'ok' | 'no_llm_capability' }
  // `null` while the summary has not loaded, as `useWorkspaceOnboarding` reports it.
  | { llmConfigured: boolean | null }

export const isLlmMissing = (signal: LlmReadinessSignal | null | undefined): boolean => {
  if (!signal) return false
  return 'reason' in signal ? signal.reason === 'no_llm_capability' : signal.llmConfigured === false
}

/** Where an operator configures a chat model provider for the workspace. */
export const buildProviderSettingsHref = (
  accountId: string,
  workspace: { workspaceId?: string; workspacePublicRouteKey?: string },
): string => buildDashboardHref(accountId, { section: 'settings', settingsTab: 'providers', ...workspace })
