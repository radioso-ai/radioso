import type { ApplicationModule } from "./radiosoModuleTypes.js";

import { createAgentWizardApplicationModule } from "./agentWizard/applicationModule.js";
import { createAnswerFeedbackApplicationModule } from "./answerFeedback/applicationModule.js";
import { createHumanContactApplicationModule } from "./humanContact/applicationModule.js";
import { createEnterpriseAuthApplicationModule } from "./mail/applicationModule.js";
import { createUsageLimitsApplicationModule } from "./usageLimits/applicationModule.js";
import { createWebsiteEmbedApplicationModule } from "./websiteEmbedApplicationModule.js";

export {
  EmailService,
  LogEmailDriver,
  NoopEmailDriver,
  ResendEmailDriver,
  createEnterpriseEmailService,
  type EmailDriver,
  type EmailMessage,
  type EmailVerificationInput,
  type EnterpriseEmailEnv,
  type PasswordResetEmailInput,
} from "./mail/emailService.js";
export {
  collectFrontendRouteContributions,
  validateFeatureManifests,
  type FeatureManifest,
  type FrontendRouteContribution,
} from "./featureManifest.js";
export { createUsageLimitsApplicationModule } from "./usageLimits/applicationModule.js";
export { createAnswerFeedbackApplicationModule } from "./answerFeedback/applicationModule.js";
export { createEnterpriseAuthApplicationModule } from "./mail/applicationModule.js";
export { createHumanContactApplicationModule } from "./humanContact/applicationModule.js";
export { createWebsiteEmbedApplicationModule } from "./websiteEmbedApplicationModule.js";
export { createWebsiteEmbedSurfaceExtension } from "./websiteEmbedSurfaceExtension.js";
export { createAgentWizardApplicationModule } from "./agentWizard/applicationModule.js";

export const createEnterpriseBackendModule = (): ApplicationModule => {
  const featureModules = [
    createUsageLimitsApplicationModule(),
    createEnterpriseAuthApplicationModule(),
    createHumanContactApplicationModule(),
    createAnswerFeedbackApplicationModule(),
    createWebsiteEmbedApplicationModule(),
    createAgentWizardApplicationModule(),
  ];

  return {
    id: "radioso-enterprise-backend",
    name: "Radioso Enterprise Backend",
    register(context) {
      for (const module of featureModules) {
        module.register?.(context);
      }
    },
    async shutdown() {
      for (const module of [...featureModules].reverse()) {
        await module.shutdown?.();
      }
    },
  };
};

export const applicationModule: ApplicationModule = createEnterpriseBackendModule();

export default applicationModule;
