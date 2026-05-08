import type { ApplicationModule } from "../radiosoModuleTypes.js";

import { answerFeedbackMigrator } from "./answerFeedbackMigrator.js";
import { createAnswerFeedbackRoutes } from "./answerFeedbackRoutes.js";
import { EnterpriseAnswerFeedbackService } from "./answerFeedbackService.js";

export interface AnswerFeedbackModuleState {
  service: EnterpriseAnswerFeedbackService | null;
}

export const createAnswerFeedbackApplicationModule = (
  state: AnswerFeedbackModuleState = { service: null },
): ApplicationModule => ({
  id: "radioso-enterprise-answer-feedback",
  name: "Radioso Enterprise Answer Feedback",
  register(context) {
    context.registerDatabaseMigrator(answerFeedbackMigrator);
    context.registerAnswerFeedbackHistoryProvider(({ database }) => {
      if (!state.service) {
        state.service = new EnterpriseAnswerFeedbackService(database);
      }
      return state.service;
    });
    context.registerRouteMount({
      path: "/api/v1/ee/answer-feedback",
      createRouter(dependencies) {
        if (!state.service) {
          state.service = new EnterpriseAnswerFeedbackService(dependencies.connectorDb);
        }
        return createAnswerFeedbackRoutes(dependencies, state.service);
      },
    });
  },
  async shutdown() {
    state.service = null;
  },
});
