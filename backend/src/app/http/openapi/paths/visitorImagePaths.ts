import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const errorResponse = (description: string, schemas: OpenApiSchemas) => ({
  description,
  content: { "application/json": { schema: schemas.ErrorResponseSchema } },
});

const jpeg = { "image/jpeg": { schema: { type: "string" as const, format: "binary" } } };

const uploadLimits = [
  "Send one image as the multipart field `image`: JPEG, PNG or WebP, at most 10 MiB, its type read from its bytes.",
  "Radioso stores it re-encoded as a JPEG at most 1,600 pixels on its long side and at most 512 KB, with its metadata (EXIF, GPS) dropped,",
  "and the agent's chat model reads it before the response, in `locale` when given, else in the agent's default locale.",
  "Send the returned `id` in the next message's `imageIds`, at most three per message; an image is sent once, and one never sent is deleted 24 hours after upload.",
  "Each image read counts as one answer against the workspace's plan; one the model could not read costs nothing.",
].join(" ");

const uploadErrors = (schemas: OpenApiSchemas) => ({
  400: errorResponse("No `image` field, more than one file, or an invalid `locale`", schemas),
  404: errorResponse("`visitor_images_unavailable`: the agent does not take images (its `visitorImagesEnabled` is off, or its chat model cannot read images)", schemas),
  413: errorResponse("`image_too_large`: over 10 MiB; or `image_too_many_pixels`: too many pixels to decode", schemas),
  415: errorResponse("`unsupported_image_type`: not a JPEG, PNG or WebP image", schemas),
  503: errorResponse("`visitor_image_busy`: the server is decoding as many images as it takes at once and none freed within a few seconds; try again", schemas),
  429: {
    description: "The upload budget is spent (`rate_limit_exceeded`), or the plan has no answers left for the reading (`usage_limit_exceeded`, the refusal a chat message gets; without `details` on the public route).",
    content: { "application/json": { schema: z.union([schemas.RateLimitExceededSchema, schemas.ErrorResponseSchema]) } },
  },
});

const imageServing = "The response is the stored JPEG with `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` and a sandbox `Content-Security-Policy`.";

/** The routes a chat's images take: upload for a message, and read back. */
export const registerVisitorImagePaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const VisitorImageUploadRequestSchema = registry.register(
    "VisitorImageUploadRequest",
    z.object({
      image: z.string().openapi({ format: "binary", description: "The image: JPEG, PNG or WebP, at most 10 MiB." }),
      locale: z.string().max(35).optional().openapi({ description: "BCP 47 tag of the language the agent writes the image's reading in." }),
    }),
  );
  const VisitorImageUploadResponseSchema = registry.register(
    "VisitorImageUploadResponse",
    z.object({
      id: z.string().uuid().openapi({ description: "Send it in the message's `imageIds`." }),
      readingStatus: z.enum(["read", "unread"]).openapi({
        description: "`read`: the agent's chat model described the image. `unread`: it could not; a message still carries the image, and its turn text marks it `<attached_photo index=\"n\" status=\"unreadable\"/>`.",
      }),
    }),
  );
  const publicImageParams = z.object({ token: z.string().min(1), imageId: z.string().uuid() });
  const conversationImageParams = z.object({ conversationId: z.string().uuid(), imageId: z.string().uuid() });
  const uploadBody = { required: true, content: { "multipart/form-data": { schema: VisitorImageUploadRequestSchema } } };
  const uploaded = { description: "Image stored and read", content: { "application/json": { schema: VisitorImageUploadResponseSchema } } };

  registry.registerPath({
    method: "post",
    path: "/api/v1/public/chat/{token}/images",
    tags: ["Assistant"],
    summary: "Upload an image for the visitor's next message",
    description: [
      "For the website embed and the public link: send the public session as `x-radioso-public-session`, as for a chat message.",
      "The session's `acceptsImages` says whether the agent takes images.",
      uploadLimits,
      "Uploads spend their own budgets, per visitor session and source and per workspace, before the agent is checked or the body read, so a refused upload still counts.",
    ].join(" "),
    operationId: "uploadPublicChatImage",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: { params: schemas.tokenPathParamsSchema, body: uploadBody },
    responses: { 201: uploaded, ...uploadErrors(schemas) },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/public/chat/{token}/images/{imageId}",
    tags: ["Assistant"],
    summary: "Read an image the visitor uploaded",
    description: `Only the public session that uploaded the image can read it, whether or not a message carries it yet. ${imageServing}`,
    operationId: "getPublicChatImage",
    security: [{ [security.anonymousSessionCookieScheme.name]: [] }],
    request: { params: publicImageParams },
    responses: {
      200: { description: "The stored image", content: jpeg },
      400: errorResponse("`imageId` is not a UUID", schemas),
      404: errorResponse("No such image for this public session", schemas),
      429: { description: "The public session's read budget is spent", content: { "application/json": { schema: schemas.RateLimitExceededSchema } } },
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/assistant/images",
    tags: ["Assistant"],
    summary: "Upload an image for a chat message",
    description: [
      "The image belongs to the API credential (or the signed-in user) that uploads it, and only it can send the image, in `POST /api/v1/assistant/chat` with the same `agentId`. Whether the agent takes images is decided by its published revision. To test a draft's images first, upload for the test with `POST /api/v1/agents/{agentId}/test-executions/{executionId}/images`.",
      uploadLimits,
      "Uploads spend their own budgets, per credential and per workspace, before the agent is checked or the body read, so a refused upload still counts.",
    ].join(" "),
    operationId: "uploadAssistantChatImage",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { query: z.object({ agentId: z.string().uuid() }), body: uploadBody },
    responses: {
      201: uploaded,
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Workspace chat permission required", schemas),
      ...uploadErrors(schemas),
      400: errorResponse("`agentId` is missing or not a UUID; no `image` field, more than one file, or an invalid `locale`; or a caller that cannot own images (only an API credential or a signed-in user can)", schemas),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/test-executions/{executionId}/images",
    tags: ["Agents"],
    summary: "Upload an image for a Test Chat message",
    description: [
      "Whether the agent takes images is decided by the revisions the test runs, so a draft that turns images on can be tested before visitors get them; in a comparison, both versions must take them. The test must be this workspace's and agent's.",
      "The image belongs to the caller who uploads it, the API credential or the signed-in user, and only it can send the image, once, as `imageIds` in `POST /api/v1/agents/{agentId}/test-executions/{executionId}/messages`. Its reading counts against the plan as a test run, as a test turn does.",
      uploadLimits,
      "Uploads spend the same per-caller and per-workspace budgets as `POST /api/v1/assistant/images`.",
    ].join(" "),
    operationId: "uploadAgentTestExecutionImage",
    security: [{ [security.bearerAuthScheme.name]: [] }],
    request: { params: z.object({ agentId: z.string().uuid(), executionId: z.string().uuid() }), body: uploadBody },
    responses: {
      201: uploaded,
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Agent management permission required", schemas),
      ...uploadErrors(schemas),
      404: errorResponse("The test is not this workspace's and agent's; or `visitor_images_unavailable`: a revision the test runs has images off, or the agent's chat model cannot read images", schemas),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/v1/agents/{agentId}/images",
    tags: ["Agent Channels"],
    summary: "Upload an image through a REST credential bound to this agent",
    description: [
      "The image belongs to the REST credential that uploads it, and only that credential can send the image, in `POST /api/v1/agents/{agentId}/chat`.",
      uploadLimits,
      "Uploads spend the channel's source budget and their own, per credential and per workspace, before the agent is checked or the body read, so a refused upload still counts.",
    ].join(" "),
    operationId: "uploadAgentChannelImage",
    security: [{ [security.agentChannelBearerAuthScheme.name]: [] }],
    request: { params: z.object({ agentId: z.string().uuid() }), body: uploadBody },
    responses: {
      201: uploaded,
      401: errorResponse("The REST credential is missing, invalid, expired, or bound to a different agent", schemas),
      ...uploadErrors(schemas),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/conversations/{conversationId}/images/{imageId}",
    tags: ["Conversation History"],
    summary: "View an image a visitor sent in a conversation",
    description: [
      "The image ids are in the user message's `inputMetadata.imageInput`.",
      "Dashboard session only, from the dashboard's own pages: bearer API tokens are rejected, and so is a browser request whose `Sec-Fetch-Site` is anything but `same-origin`. An `<img>` element cannot send `X-Workspace-Id`, so the optional `workspaceId` query selects the workspace instead. `HEAD` is refused with `405`.",
      imageServing,
      "Every response that carries the image records a `conversation.image_viewed` audit event with the teammate's user id.",
    ].join(" "),
    operationId: "getConversationImage",
    security: security.workspaceAdminSecurity,
    request: {
      params: conversationImageParams,
      query: z.object({ workspaceId: z.string().uuid().optional() }),
    },
    responses: {
      200: { description: "The stored image", content: jpeg },
      400: errorResponse("Invalid conversation or image id", schemas),
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Workspace history read permission required, the caller is not a dashboard session, or another site started the request", schemas),
      404: errorResponse("The conversation carries no such image", schemas),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/v1/agents/{agentId}/test-executions/{executionId}/images/{imageId}",
    tags: ["Agents"],
    summary: "View an image in a Test Chat transcript",
    description: [
      "A test keeps its transcript apart from conversations, so its images are read here. The image ids are in a user entry's `imageInput` in the test's history.",
      "It serves an image sent in the test, or one the test's history names from the comparison it continues or the conversation it started from. Before the message that sends it is stored, it serves an image only to the caller who uploaded it.",
      "Dashboard session only, from the dashboard's own pages: bearer API tokens are rejected, and so is a browser request whose `Sec-Fetch-Site` is anything but `same-origin`. An `<img>` element cannot send `X-Workspace-Id`, so the optional `workspaceId` query selects the workspace instead. `HEAD` is refused with `405`.",
      imageServing,
      "Every response that carries an image records an audit event with the teammate's user id: `conversation.image_viewed` for a visitor's image copied in with a conversation, and `agent.test_execution.image_viewed`, naming the test, for any other.",
    ].join(" "),
    operationId: "getAgentTestExecutionImage",
    security: security.workspaceAdminSecurity,
    request: {
      params: z.object({ agentId: z.string().uuid(), executionId: z.string().uuid(), imageId: z.string().uuid() }),
      query: z.object({ workspaceId: z.string().uuid().optional() }),
    },
    responses: {
      200: { description: "The stored image", content: jpeg },
      400: errorResponse("Invalid agent, test or image id", schemas),
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Agent management and history read permissions required, the caller is not a dashboard session, or another site started the request", schemas),
      404: errorResponse("The test is gone, or it carries no such image", schemas),
    },
  });
};
