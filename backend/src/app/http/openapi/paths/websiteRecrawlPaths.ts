import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { recrawlCadences } from "../../../../modules/websiteCrawler/public.js";
import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const TAGS = ["Documents"];

/**
 * A website source's recrawl cadence, and the operator's decision on the pages a scheduled recrawl
 * held instead of removing. Each needs `workspace.documents.manage`.
 */
export const registerWebsiteRecrawlPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const sec = [{ [security.bearerAuthScheme.name]: [] }];
  const json = (schema: z.ZodTypeAny) => ({ "application/json": { schema } });
  const errorResponse = (description: string) => ({ description, content: json(schemas.ErrorResponseSchema) });
  const unauthenticated = errorResponse("Authentication required");
  const notFound = errorResponse("Source not found");
  const notWebsite = errorResponse("Request validation failed, or the source is not a website source");

  const RecrawlCadenceRequestSchema = registry.register(
    "DocumentSourceRecrawlCadenceRequest",
    z.object({
      recrawlCadence: z.enum(recrawlCadences).openapi({
        description: "How often the source recrawls itself. `off` stops scheduled recrawls.",
      }),
    }).strict(),
  );
  const HeldPagesRemovedSchema = registry.register(
    "DocumentSourceHeldPagesRemoved",
    z.object({ sourceId: z.string().uuid(), removedPageCount: z.number().int().min(0) }),
  );
  const HeldPagesKeptSchema = registry.register(
    "DocumentSourceHeldPagesKept",
    z.object({ sourceId: z.string().uuid(), keptPageCount: z.number().int().min(0) }),
  );

  registry.registerPath({
    method: "put",
    path: "/api/v1/document/sources/{sourceId}/recrawl-cadence",
    tags: TAGS,
    summary: "Set how often a website source recrawls itself",
    description:
      "Turning a cadence on or changing it schedules the next recrawl one interval after the last crawl, never before now, with up to an hour of jitter. Choosing the stored cadence again keeps the scheduled time; `off` clears it. A scheduled recrawl reuses the source's saved crawl settings, and holds its missing pages for review when they are more than a fifth of the source.",
    operationId: "setDocumentSourceRecrawlCadence",
    security: sec,
    request: { params: schemas.sourceParamsSchema, body: { content: json(RecrawlCadenceRequestSchema) } },
    responses: {
      200: { description: "The source with its new cadence", content: json(schemas.DocumentSourceListItemSchema) },
      400: notWebsite,
      401: unauthenticated,
      403: errorResponse(
        "Workspace documents manage permission required, or `recrawl_cadence_not_in_plan`: the plan allows a slower cadence at most; `details.fastestRecrawlCadence` names it",
      ),
      404: notFound,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/document/sources/{sourceId}/held-pages/remove",
    tags: TAGS,
    summary: "Remove the pages a crawl held",
    description: "Deletes the source's held pages the way a recrawl removes missing pages. A source with no held pages answers with a count of 0.",
    operationId: "removeDocumentSourceHeldPages",
    security: sec,
    request: { params: schemas.sourceParamsSchema },
    responses: {
      200: { description: "Held pages removed", content: json(HeldPagesRemovedSchema) },
      400: notWebsite,
      401: unauthenticated,
      403: errorResponse("Workspace documents manage permission required"),
      404: notFound,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/document/sources/{sourceId}/held-pages/keep",
    tags: TAGS,
    summary: "Keep the pages a crawl held",
    description:
      "Keeps the source's held pages. Later crawls neither hold nor remove a kept page; a page that appears on the site again stops being kept.",
    operationId: "keepDocumentSourceHeldPages",
    security: sec,
    request: { params: schemas.sourceParamsSchema },
    responses: {
      200: { description: "Held pages kept", content: json(HeldPagesKeptSchema) },
      400: notWebsite,
      401: unauthenticated,
      403: errorResponse("Workspace documents manage permission required"),
      404: notFound,
    },
  });
};
