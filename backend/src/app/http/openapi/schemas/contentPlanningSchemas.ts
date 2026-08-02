import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  contentPlanDetailSchema,
  contentPlanEmergingQuestionSchema,
  contentPlanPageSchema,
  contentPlanProjectionSchema,
  contentPlanSummarySchema,
  contentPlanTopicDetailParamsSchema,
  contentPlanTopicSummarySchema,
} from "../../../../modules/contentPlanning/contracts/index.js";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerContentPlanningSchemas = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemaCatalog,
) => {
  schemas.ContentPlanProjectionSchema = registry.register(
    "ContentPlanProjection",
    contentPlanProjectionSchema,
  );
  schemas.ContentPlanSummarySchema = registry.register(
    "ContentPlanSummary",
    contentPlanSummarySchema,
  );
  schemas.ContentPlanTopicSummarySchema = registry.register(
    "ContentPlanTopicSummary",
    contentPlanTopicSummarySchema,
  );
  schemas.ContentPlanEmergingQuestionSchema = registry.register(
    "ContentPlanEmergingQuestion",
    contentPlanEmergingQuestionSchema,
  );
  schemas.ContentPlanPageSchema = registry.register("ContentPlanPage", contentPlanPageSchema);
  schemas.ContentPlanTopicDetailSchema = registry.register(
    "ContentPlanTopicDetail",
    contentPlanDetailSchema,
  );
  schemas.ContentPlanTopicParamsSchema = registry.register(
    "ContentPlanTopicParams",
    contentPlanTopicDetailParamsSchema,
  );
};
