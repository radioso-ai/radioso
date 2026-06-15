/**
 * Customer-owned outbound email integrations.
 *
 * This module is intentionally separate from `modules/mail`, which owns
 * Radioso transactional email such as password reset and verification.
 */

export const customerEmailSkillOutcomes = [
  "drafted",
  "sent",
  "missing_input",
  "disabled_connection",
  "needs_reauth",
  "provider_rejected",
  "failed",
] as const;

export type CustomerEmailSkillOutcome = (typeof customerEmailSkillOutcomes)[number];

export {
  buildCustomerEmailOauthProviderDefinitions,
  assertCustomerEmailScopes,
  customerEmailCapabilities,
  customerEmailOauthProviderIds,
  getCustomerEmailProviderMetadata,
  requiredCustomerEmailScopes,
  type CustomerEmailOauthProviderCredentialConfig,
  type CustomerEmailCapability,
  type CustomerEmailOauthProviderId,
  type CustomerEmailProviderMetadata,
} from "./oauthMailProviders.js";
export {
  CustomerEmailOAuthService,
  type CustomerEmailOAuthPort,
} from "./services/customerEmailOAuthService.js";
export {
  CustomerEmailConnectionService,
  type CustomerEmailConnectionServiceOptions,
  type CustomerEmailOauthStatusPort,
} from "./services/customerEmailConnectionService.js";
export {
  customerEmailConnectionCreateSchema,
  customerEmailConnectionStatuses,
  customerEmailConnectionUpdateSchema,
  customerEmailHealthStatuses,
  type CustomerEmailConnectionCreateInput,
  type CustomerEmailConnectionStatus,
  type CustomerEmailConnectionSummary,
  type CustomerEmailConnectionUpdateInput,
  type CustomerEmailHealthStatus,
} from "./domain.js";
export {
  MockCustomerEmailProviderAdapter,
} from "./providers/mockEmailProvider.js";
export {
  StaticCustomerEmailProviderRegistry,
  type CustomerEmailProviderAdapter,
  type CustomerEmailProviderHealthResult,
  type CustomerEmailProviderRegistryPort,
} from "./providers/customerEmailProvider.js";
