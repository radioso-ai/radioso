import {
  ContentPlanCursorCodec,
  ContentPlanReadService,
  PostgresContentPlanReadSource,
  createContentPlanningRoutes,
} from "../../../modules/contentPlanning/composition.js";
import { QualityContentPlanningEvidenceSource } from "../../../modules/quality/composition.js";
import type { AppDependencies } from "../../server/types.js";
import { EvalQualityVerificationSource } from "../adapters/evalQualityVerificationSource.js";
import type { ApplicationModule } from "../applicationModule.js";

export const createContentPlanningApplicationModule = (): ApplicationModule => ({
  id: "radioso-content-planning",
  name: "Radioso Content Planning",
  register(context) {
    context.registerRouteMount({
      path: "/api/v1/quality/content-plan",
      createRouter(dependencies) {
        const qualityEvidence = new QualityContentPlanningEvidenceSource(
          dependencies.connectorDb.kysely,
          new EvalQualityVerificationSource(dependencies.evalMessageCaseService),
        );
        const service = new ContentPlanReadService({
          source: new PostgresContentPlanReadSource(dependencies.connectorDb.kysely),
          qualityEvidence,
          cursorCodec: new ContentPlanCursorCodec(
            `${dependencies.env.SESSION_COOKIE_SECRET}:content-plan:v1`,
          ),
        });
        return createContentPlanningRoutes(dependencies, service);
      },
    });
  },
});
