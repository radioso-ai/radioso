import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { registerTestExecutionSchemas } from "../schemas/testExecutionSchemas.js";

/** The voice session answer Test Chat's Talk shares with the website embed's start, and the error envelope. */
interface TestChatVoiceSchemas {
  PublicVoiceSessionResponseSchema: z.ZodTypeAny;
  ErrorResponseSchema: z.ZodTypeAny;
}

/** Separate registration avoids coupling the test-execution slice to authoring schemas. */
export const registerTestExecutionPaths = (
  registry: OpenAPIRegistry,
  security: { bearerAuthScheme: { name: string } },
  evalSnapshotSchema: z.ZodTypeAny = z.unknown(),
  voice?: TestChatVoiceSchemas,
) => {
  const schemas = registerTestExecutionSchemas(registry);
  const authenticated = [{ [security.bearerAuthScheme.name]: [] }];
  registry.registerPath({ method: "get", path: "/api/v1/agents/{agentId}/test-executions", tags: ["Agents"], summary: "List private immutable revision tests", operationId: "listAgentTestExecutions", security: authenticated, request: { params: z.object({ agentId: z.string().uuid() }), query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().min(1).optional() }) }, responses: { 200: { description: "Private test history returned", content: { "application/json": { schema: schemas.TestExecutionHistoryListResponseSchema } } } } });
  registry.registerPath({ method: "get", path: "/api/v1/agents/{agentId}/test-executions/{executionId}", tags: ["Agents"], summary: "Get private immutable revision test evidence", operationId: "getAgentTestExecution", security: authenticated, request: { params: schemas.TestExecutionParamsSchema }, responses: { 200: { description: "Private test evidence returned", content: { "application/json": { schema: schemas.TestExecutionHistoryDetailResponseSchema } } } } });
  registry.registerPath({ method: "post", path: "/api/v1/agents/{agentId}/test-executions", tags: ["Agents"], summary: "Start an operator-private immutable revision test", description: "A `single` execution may set `seedConversationId` to continue an existing conversation of the same workspace and agent: the side starts with that thread as its history and resumes its active routine, pending clarification, and directive state, skipping the greeting. The source conversation is unchanged.", operationId: "startAgentTestExecution", security: authenticated, request: { params: z.object({ agentId: z.string().uuid() }), body: { required: true, content: { "application/json": { schema: schemas.StartTestExecutionRequestSchema } } } }, responses: { 201: { description: "Private test execution created", content: { "application/json": { schema: schemas.TestExecutionSchema } } } } });
  const sse = { "text/event-stream": { schema: schemas.TestExecutionEventSchema } };
  registry.registerPath({ method: "post", path: "/api/v1/agents/{agentId}/test-executions/{executionId}/messages", tags: ["Agents"], summary: "Run a fenced private test turn", operationId: "sendAgentTestExecutionMessage", security: authenticated, request: { params: schemas.TestExecutionParamsSchema, body: { required: true, content: { "application/json": { schema: schemas.TestExecutionMessageRequestSchema } } } }, responses: { 200: { description: "Fenced side events", content: sse } } });
  registry.registerPath({ method: "post", path: "/api/v1/agents/{agentId}/test-executions/{executionId}/sides/{sideId}/retain", tags: ["Agents"], summary: "Continue one settled comparison version as a private test", operationId: "retainAgentTestExecutionSide", security: authenticated, request: { params: schemas.TestExecutionRetainParamsSchema }, responses: { 201: { description: "Single private test execution created", content: { "application/json": { schema: schemas.TestExecutionSchema } } } } });
  registry.registerPath({ method: "post", path: "/api/v1/agents/{agentId}/test-executions/{executionId}/sides/{sideId}/eval-snapshots/{messageId}", tags: ["Agents"], summary: "Capture a private test response as immutable Eval evidence", operationId: "captureAgentTestExecutionEvalSnapshot", security: authenticated, request: { params: schemas.TestExecutionRetainParamsSchema.extend({ messageId: z.string().min(1) }) }, responses: { 201: { description: "Immutable Eval snapshot captured from the private test turn", content: { "application/json": { schema: evalSnapshotSchema } } } } });
  registry.registerPath({ method: "post", path: "/api/v1/agents/{agentId}/test-executions/{executionId}/sides/{sideId}/retry", tags: ["Agents"], summary: "Retry one failed private test side", operationId: "retryAgentTestExecutionSide", security: authenticated, request: { params: schemas.TestExecutionRetryParamsSchema, body: { required: true, content: { "application/json": { schema: schemas.TestExecutionRetryRequestSchema } } } }, responses: { 200: { description: "Fenced side events", content: sse } } });
  if (voice) registerTestChatVoiceSessionPath(registry, schemas, voice, authenticated);
};

const registerTestChatVoiceSessionPath = (
  registry: OpenAPIRegistry,
  schemas: ReturnType<typeof registerTestExecutionSchemas>,
  voice: TestChatVoiceSchemas,
  security: Array<Record<string, string[]>>,
) => {
  const error = (description: string) => ({ description, content: { "application/json": { schema: voice.ErrorResponseSchema } } });
  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/test-executions/{executionId}/voice-sessions",
    tags: ["Agents"],
    summary: "Start a voice session on a private test",
    description: [
      "Test Chat's Talk. Opens a session on the vendor agent the agent's `voice.runtime` names, with the workspace's own vendor key, and returns the same answer as `createPublicVoiceSession`.",
      "Every turn of the session runs on the test's revision and is recorded in the test as spoken, never as a conversation: no Inbox, Activity, analytics, visitor or conversation metering.",
      "The session's turns are taken for 60 minutes; later ones are refused.",
      "A dashboard session only, with `X-Radioso-CSRF: 1`. The agent must take voice calls as the website embed's start requires: published, voice on, a vendor agent bound, and the vendor key stored.",
      "The call opens with the test's own greeting while no message has been sent, on a vendor agent Radioso maintains. The signed URL is a bearer credential: the response is `Cache-Control: no-store`.",
    ].join(" "),
    operationId: "startAgentTestExecutionVoiceSession",
    security,
    request: {
      params: schemas.TestExecutionParamsSchema,
      body: { content: { "application/json": { schema: schemas.TestChatVoiceSessionRequestSchema } } },
    },
    responses: {
      200: { description: "Voice session started", content: { "application/json": { schema: voice.PublicVoiceSessionResponseSchema } } },
      400: error("Request validation failed"),
      401: error("No dashboard session"),
      403: error("The CSRF header is missing, or the operator may not manage the agent"),
      404: error("The test is gone, or the agent takes no voice calls: it has never been published, voice is off, or no vendor agent is bound"),
      409: error("`test_execution_not_single`: a comparison test takes no spoken turns"),
      503: error("`voice_unavailable`: the session could not be started (the vendor key is missing or unreadable, or the vendor did not start it)"),
    },
  });
};
