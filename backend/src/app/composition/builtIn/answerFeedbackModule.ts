import {
  AnswerFeedbackService,
  createAnswerFeedbackRoutes,
} from "../../../modules/chat/composition.js";
import type { ApplicationModule } from "../applicationModule.js";

export interface AnswerFeedbackModuleState {
  service: AnswerFeedbackService | null;
}

export const createAnswerFeedbackApplicationModule = (
  state: AnswerFeedbackModuleState = { service: null },
): ApplicationModule => ({
  id: "radioso-answer-feedback",
  name: "Radioso Answer Feedback",
  register(context) {
    context.registerAnswerFeedbackHistoryProvider(({ database }) => {
      if (!state.service) {
        state.service = new AnswerFeedbackService(database);
      }
      return state.service;
    });
    context.registerRouteMount({
      path: "/api/v1/answer-feedback",
      createRouter(dependencies) {
        if (!state.service) {
          state.service = new AnswerFeedbackService(dependencies.connectorDb);
        }
        return createAnswerFeedbackRoutes(dependencies, state.service);
      },
    });
  },
  async shutdown() {
    state.service = null;
  },
});
