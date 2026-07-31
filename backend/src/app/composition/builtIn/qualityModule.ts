import {
  QualityTurnsService,
  SkillCatalogOutcomeSource,
  createQualityRoutes,
} from "../../../modules/quality/composition.js";
import type { ApplicationModule } from "../applicationModule.js";

export const createQualityApplicationModule = (): ApplicationModule => ({
  id: "radioso-quality",
  name: "Radioso Quality",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/quality",
      createRouter(dependencies) {
        // Signal classification reads the skill catalog to learn which outcomes ground an
        // answer. The adapter narrows the catalog to that one question.
        const service = new QualityTurnsService(
          dependencies.connectorDb.kysely,
          new SkillCatalogOutcomeSource(dependencies.skillCatalogService),
          undefined,
          {
            getByAssistantMessageIds: (workspaceId, assistantMessageIds) =>
              dependencies.evalMessageCaseService.lookupVerifications(
                workspaceId,
                assistantMessageIds,
              ),
          },
        );
        return createQualityRoutes(dependencies, service);
      },
    });
  },
});
