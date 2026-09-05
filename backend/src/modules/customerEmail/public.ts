/**
 * Customer-owned outbound email integrations.
 *
 * This module is intentionally separate from `modules/mail`, which owns
 * Radioso transactional email such as password reset and verification.
 */

export { customerEmailOauthProviderIds } from "./oauthMailProviders.js";
export { CustomerEmailOAuthService } from "./services/customerEmailOAuthService.js";
export { CustomerEmailConnectionService } from "./services/customerEmailConnectionService.js";
export {
  customerEmailConnectionCreateSchema,
  customerEmailBoundInputsSchema,
  customerEmailExposedInputsSchema,
  customerEmailSkillDefinitionCreateSchema,
  customerEmailSkillDefinitionUpdateSchema,
  customerEmailSkillModes,
  customerEmailSkillOutcomes,
  requiredCustomerEmailSkillInputs,
  emailSkillActivityQuerySchema,
  customerEmailConnectionUpdateSchema,
} from "./domain.js";
export { presentEmailSkillActivity } from "./services/emailSkillActivityPresenter.js";
export { EmailSkillDefinitionService } from "./services/emailSkillDefinitionService.js";
export {
  MockCustomerEmailProviderAdapter,
} from "./providers/mockEmailProvider.js";
export { StaticCustomerEmailProviderRegistry } from "./providers/customerEmailProvider.js";
export {
  CUSTOMER_EMAIL_SKILLS_ADAPTER,
  EmailSkillExecutor,
} from "./executor/emailSkillExecutor.js";
export { CustomerEmailDeliveryService } from "./services/customerEmailDeliveryService.js";
export { CustomerEmailRoutineSkillResolver } from "./routineSkillResolver.js";
