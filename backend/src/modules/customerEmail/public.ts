/**
 * Customer-owned outbound email integrations.
 *
 * This module is intentionally separate from `modules/mail`, which owns
 * Radioso transactional email such as password reset and verification.
 */

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
  customerEmailBoundInputsSchema,
  customerEmailExposedInputsSchema,
  customerEmailSkillDefinitionCreateSchema,
  customerEmailSkillDefinitionUpdateSchema,
  customerEmailSkillInputKeys,
  customerEmailSkillModes,
  customerEmailSkillOutcomes,
  emailSkillActivityQuerySchema,
  customerEmailConnectionStatuses,
  customerEmailConnectionUpdateSchema,
  customerEmailHealthStatuses,
  type CustomerEmailConnectionCreateInput,
  type CustomerEmailConnectionStatus,
  type CustomerEmailConnectionSummary,
  type CustomerEmailConnectionUpdateInput,
  type CustomerEmailHealthStatus,
  type CustomerEmailSkillDefinitionCreateInput,
  type CustomerEmailSkillDefinitionSummary,
  type CustomerEmailSkillDefinitionUpdateInput,
  type CustomerEmailSkillInputKey,
  type CustomerEmailSkillMode,
  type CustomerEmailSkillOutcome,
  type EmailSkillActivityQueryInput,
  type EmailSkillActivitySummary,
  type EmailSkillRecipientSummary,
} from "./domain.js";
export {
  buildEmailSkillActivityAuditPayload,
  buildEmailSkillActivityRecordInput,
  presentEmailSkillActivity,
  summarizeEmailRecipients,
} from "./services/emailSkillActivityPresenter.js";
export {
  EmailSkillDefinitionService,
  type EmailSkillDefinitionServiceOptions,
} from "./services/emailSkillDefinitionService.js";
export {
  MockCustomerEmailProviderAdapter,
} from "./providers/mockEmailProvider.js";
export {
  CustomerEmailProviderRejectedError,
  StaticCustomerEmailProviderRegistry,
  type CustomerEmailProviderAdapter,
  type CustomerEmailMessageInput,
  type CustomerEmailProviderDeliveryResult,
  type CustomerEmailProviderHealthResult,
  type CustomerEmailProviderRegistryPort,
} from "./providers/customerEmailProvider.js";
export {
  CUSTOMER_EMAIL_SKILLS_ADAPTER,
  EmailSkillExecutor,
  type EmailSkillActivitySinkPort,
  type EmailSkillExecutorOptions,
} from "./executor/emailSkillExecutor.js";
export {
  CustomerEmailDeliveryService,
  type CustomerEmailDeliveryServiceOptions,
  type CustomerEmailOauthCredentialLookupPort,
} from "./services/customerEmailDeliveryService.js";
export {
  CustomerEmailRoutineSkillResolver,
  customerEmailRoutineSkillDefinition,
} from "./routineSkillResolver.js";
