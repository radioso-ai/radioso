import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

const errorResponse = (description: string, schemas: OpenApiSchemas) => ({
  description,
  content: { "application/json": { schema: schemas.ErrorResponseSchema } },
});

const audio = { "audio/mpeg": { schema: { type: "string" as const, format: "binary" } } };

export const registerConversationRecordingPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  registry.registerPath({
    method: "get",
    path: "/api/v1/conversations/{conversationId}/recording",
    tags: ["Conversation History"],
    summary: "Play a voice conversation's recording",
    description: [
      "Streams the call's audio from the voice vendor, which keeps the recording, with the workspace's own vendor key; the key and the vendor's URL stay on the backend.",
      "A conversation has one when its call was started by the website embed and the page reported the vendor's conversation id: `recording.available` on the conversation's detail says so.",
      "Dashboard session only, from the dashboard's own pages: bearer API tokens are rejected, and so is a browser request whose `Sec-Fetch-Site` is anything but `same-origin`. An `<audio>` element cannot send `X-Workspace-Id`, so the optional `workspaceId` query selects the workspace instead. `HEAD` is refused with `405`.",
      "A `Range` header naming one byte range (`bytes=first-`, `bytes=first-last` or `bytes=-suffix`) goes on to the vendor, and the response is `206` with the vendor's `Content-Range` when the vendor answers it; a vendor that ignores it answers with the whole recording, and a range past the end is `416`.",
      "The response is `Cache-Control: private, no-store`. Every response that carries audio records a `conversation.recording_played` audit event with the teammate's user id; `partial` is true when the audio sent starts past the recording's first byte.",
    ].join(" "),
    operationId: "getConversationRecording",
    security: security.workspaceAdminSecurity,
    request: {
      params: schemas.conversationParamsSchema,
      query: z.object({ workspaceId: z.string().uuid().optional() }),
      headers: z.object({ range: z.string().optional() }),
    },
    responses: {
      200: { description: "The whole recording", content: audio },
      206: { description: "The byte range the request named", content: audio },
      416: { description: "The byte range lies past the recording's end; `Content-Range` names its length when the vendor does" },
      400: errorResponse("Invalid conversation id", schemas),
      401: errorResponse("Authentication required", schemas),
      403: errorResponse("Workspace history read permission required, the caller is not a dashboard session, or another site started the request", schemas),
      404: errorResponse("The conversation has no recording, or the vendor holds no audio for the call yet", schemas),
      503: errorResponse("`recording_unavailable`: the recording could not be read (the workspace's vendor key is missing or unreadable, or the vendor did not answer)", schemas),
    },
  });
};
