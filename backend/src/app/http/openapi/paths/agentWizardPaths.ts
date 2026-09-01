import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

export const registerAgentWizardPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const errorResponse = (description: string) => ({
    description,
    content: { "application/json": { schema: schemas.ErrorResponseSchema } },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agent-wizard/analyze-website",
    tags: ["Agents"],
    summary: "Analyze a website and suggest an agent configuration",
    description: "Fetches and reads a public website, then returns a suggested agent name, instruction, greeting, locale, and chunking strategy. Persists nothing. Fetching an external site and running a model against it costs real time and budget, so the route carries its own durable rate limit.",
    operationId: "analyzeWebsiteForAgentWizard",
    security: security.workspaceAdminSecurity,
    request: {
      body: { required: true, content: { "application/json": { schema: schemas.AgentWizardAnalyzeRequestSchema } } },
    },
    responses: {
      200: { description: "Suggested configuration derived from the site", content: { "application/json": { schema: schemas.AgentWizardAnalysisSchema } } },
      400: errorResponse("Request body or URL is invalid"),
      401: errorResponse("Workspace session required"),
      403: errorResponse("Caller lacks workspace.agents.manage"),
      422: errorResponse("The site could not be reached, required authentication, or carried too little content to analyze"),
      429: errorResponse("Analysis rate limit exceeded"),
      503: errorResponse("Rate-limit state or workspace inference capability is unavailable"),
      504: errorResponse("Website analysis exceeded its time budget"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agent-wizard/analyze-website/stream",
    tags: ["Agents"],
    summary: "Stream website analysis progress",
    description: "The same analysis as the non-streaming route, delivered as server-sent events so a caller can show crawl progress. Emits progress events, then one complete event carrying the suggested configuration, or one error event when the analysis fails after the headers are sent.",
    operationId: "streamAgentWizardWebsiteAnalysis",
    security: security.workspaceAdminSecurity,
    request: {
      body: { required: true, content: { "application/json": { schema: schemas.AgentWizardAnalyzeRequestSchema } } },
    },
    responses: {
      200: {
        description: "Server-sent progress events followed by the suggested configuration, or an error event",
        headers: {
          "Cache-Control": { description: "Disables intermediary transformation and caching.", schema: { type: "string" as const, const: "no-cache, no-transform" } },
          Connection: { description: "Keeps the HTTP connection open for the event stream.", schema: { type: "string" as const, const: "keep-alive" } },
        },
        content: { "text/event-stream": { schema: schemas.AgentWizardAnalysisStreamSchema } },
      },
      // The stream commits its 200 before the analysis starts, so every analysis failure arrives as
      // an error event carrying its own statusCode rather than as a response status. Only the
      // validation and admission checks that run before the headers are sent reach the wire here.
      400: errorResponse("Request body or URL is invalid"),
      401: errorResponse("Workspace session required"),
      403: errorResponse("Caller lacks workspace.agents.manage"),
      429: errorResponse("Analysis rate limit exceeded"),
      503: errorResponse("Rate-limit state is unavailable"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agent-wizard/create",
    tags: ["Agents"],
    summary: "Create an agent from a website configuration",
    description: "Creates one agent from a reviewed wizard configuration and queues the website for ingestion. Returns the new agent and the crawl job when the deployment runs website crawling.",
    operationId: "createAgentFromWizard",
    security: security.workspaceAdminSecurity,
    request: {
      body: { required: true, content: { "application/json": { schema: schemas.AgentWizardCreateRequestSchema } } },
    },
    responses: {
      201: { description: "Agent created; the response names any step after creation that did not finish", content: { "application/json": { schema: schemas.AgentWizardCreateResponseSchema } } },
      400: errorResponse("Request body or one of its URLs is invalid"),
      401: errorResponse("Workspace session required"),
      403: errorResponse("Caller lacks workspace.agents.manage"),
      429: errorResponse("Creation rate limit exceeded"),
      503: errorResponse("Rate-limit state is unavailable"),
    },
  });
};
