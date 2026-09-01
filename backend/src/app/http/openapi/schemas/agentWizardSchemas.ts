import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import {
  agentWizardAnalysisSchema,
  agentWizardAnalyzeRequestSchema,
  agentWizardCreateRequestSchema,
  agentWizardCreateResultSchema,
  agentWizardProgressEventSchema,
  agentWizardStreamErrorSchema,
} from "../../../../modules/agentWizard/contracts.js";
import type { OpenApiSchemaCatalog } from "../openApiRegistry.js";

export const registerAgentWizardSchemas = (registry: OpenAPIRegistry, schemas: OpenApiSchemaCatalog) => {
  schemas.AgentWizardAnalyzeRequestSchema = registry.register("AgentWizardAnalyzeRequest", agentWizardAnalyzeRequestSchema);
  schemas.AgentWizardAnalysisSchema = registry.register("AgentWizardAnalysis", agentWizardAnalysisSchema);
  schemas.AgentWizardProgressEventSchema = registry.register("AgentWizardProgressEvent", agentWizardProgressEventSchema);
  schemas.AgentWizardStreamErrorSchema = registry.register("AgentWizardStreamError", agentWizardStreamErrorSchema);
  schemas.AgentWizardCreateRequestSchema = registry.register("AgentWizardCreateRequest", agentWizardCreateRequestSchema);
  schemas.AgentWizardCreateResponseSchema = registry.register("AgentWizardCreateResponse", agentWizardCreateResultSchema);
  // The stream body is text, not one JSON document, so the response schema names the events it
  // carries and points at the payload schema each one's data field matches.
  schemas.AgentWizardAnalysisStreamSchema = registry.register("AgentWizardAnalysisStream", z.string().openapi({
    description: [
      "A server-sent event stream with named progress, complete, and error events.",
      "Each progress event's data field matches AgentWizardProgressEvent; the single complete event carries the whole AgentWizardAnalysis;",
      "an error event carries AgentWizardStreamError and is emitted in place of complete when the analysis fails after the headers are sent.",
      "The stream ends after complete or error.",
    ].join(" "),
    example: [
      "event: progress",
      'data: {"type":"progress","step":"crawling","page":1,"total":8,"url":"https://acme.example.com","title":"Acme"}',
      "",
      "event: progress",
      'data: {"type":"progress","step":"generating"}',
      "",
      "event: complete",
      'data: {"suggestedName":"Acme Support","sourceUrl":"https://acme.example.com","pagesAnalyzed":[]}',
      "",
    ].join("\n"),
  }));
};
