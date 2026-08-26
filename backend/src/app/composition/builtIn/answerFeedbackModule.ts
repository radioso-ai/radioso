import {
  AnswerFeedbackService,
  createAnswerFeedbackRoutes,
} from "../../../modules/chat/composition.js";
import type { ApplicationModule } from "../applicationModule.js";
import { createNoopWorkspaceInvalidationPublisher } from "@radioso/workspace-invalidation-contract";

export interface AnswerFeedbackModuleState {
  service: AnswerFeedbackService | null;
}

export const createAnswerFeedbackApplicationModule = (
  state: AnswerFeedbackModuleState = { service: null },
): ApplicationModule => ({
  id: "radioso-answer-feedback",
  name: "Radioso Answer Feedback",
  register(context) {
    context.registerAnswerFeedbackHistoryProvider(({ database, workspaceInvalidationPublisher }) => {
      if (!state.service) {
        state.service = new AnswerFeedbackService(
          database,
          workspaceInvalidationPublisher ?? createNoopWorkspaceInvalidationPublisher(),
        );
      }
      return state.service;
    });
    context.registerRouteMount({
      path: "/api/v1/answer-feedback",
      createRouter(dependencies) {
        if (!state.service) {
          state.service = new AnswerFeedbackService(
            dependencies.connectorDb.kysely,
            dependencies.workspaceInvalidationPublisher,
          );
        }
        return createAnswerFeedbackRoutes(dependencies, state.service);
      },
    });
  },
  async shutdown() {
    state.service = null;
  },
});
