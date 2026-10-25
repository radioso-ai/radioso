import { z } from "zod";
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

import { VOICE_RECORDING_LEFT_REASONS } from "../../../../modules/voiceChannel/public.js";
import { voiceRecordingsLeftAtVendorQuerySchema } from "../../routes/accountVoiceRecordingRoutes.js";
import type { OpenApiSchemas, OpenApiSecurity } from "../openApiRegistry.js";

/**
 * The organization's call recordings its deletions left at the voice vendor for good: deleting a
 * conversation, visitor, workspace or the organization asks the vendor to delete each recording,
 * with retries for about a day, and this lists the ones it would not delete.
 */
export const registerAccountVoiceRecordingPaths = (
  registry: OpenAPIRegistry,
  schemas: OpenApiSchemas,
  security: OpenApiSecurity,
) => {
  const LeftAtVendorSchema = registry.register("VoiceRecordingLeftAtVendor", z.object({
    vendor: z.string().openapi({ description: "The voice vendor that keeps the recording, such as `elevenlabs`." }),
    vendorRegion: z.string().openapi({ description: "The data residency region of the vendor account the recording is in, such as `eu`." }),
    vendorConversationId: z.string().openapi({ description: "The vendor's own id for the call: delete it in the vendor's dashboard or API by this id." }),
    conversationId: z.string().uuid().nullable().openapi({ description: "The deleted conversation's id; null for a call whose first turn never came." }),
    workspaceId: z.string().uuid().openapi({ description: "The workspace the call was in, which may itself be deleted." }),
    reason: z.enum(VOICE_RECORDING_LEFT_REASONS).openapi({
      description: "Why it is still at the vendor: `credential_missing` (the workspace held no vendor key when it was deleted), `credential_unreadable` (a key could not be decrypted), `vendor_rejected`, `vendor_unreachable`, `vendor_timeout`, `vendor_malformed_response` or `vendor_failed` (the vendor's last answer, after eight asks over about a day), `vendor_unsupported` (this deployment knows no host for the vendor or region), `expired` (still pending a week after its deletion), or `drain_failed` (the deleting job itself kept failing).",
    }),
    failedAt: z.string().datetime().openapi({ description: "When Radioso gave up on it." }),
  }));
  const ResponseSchema = registry.register("VoiceRecordingsLeftAtVendorResponse", z.object({
    total: z.number().int().min(0).openapi({ description: "How many recordings the organization's deletions left at the vendor in all." }),
    recordings: z.array(LeftAtVendorSchema).openapi({ description: "Newest first, at most `limit`." }),
    nextCursor: z.string().nullable().openapi({ description: "Pass as `cursor` to read the next page; null on the last page." }),
  }));
  const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: schemas.ErrorResponseSchema } } });

  registry.registerPath({
    method: "get",
    path: "/api/v1/account/voice-recordings/left-at-vendor",
    tags: ["Account"],
    summary: "List call recordings the organization's deletions left at the voice vendor",
    description: [
      "Deleting a conversation, a visitor, a workspace or the organization asks the voice vendor to delete each call's recording, retrying what it refuses for about a day.",
      "This lists the recordings it gave up on, across every workspace of the organization, deleted ones included, newest first, so they can be deleted in the vendor account by `vendorConversationId`. Page with `cursor`, from the previous page's `nextCursor`.",
      "Each is also recorded as a `conversation.recording_deleted` audit event with status `failure`.",
      "Account session only; owners and admins (`workspace.history.delete` on the organization). The response is `Cache-Control: no-store`.",
    ].join(" "),
    operationId: "listVoiceRecordingsLeftAtVendor",
    security: [{ [security.sessionCookieScheme.name]: [] }],
    request: { query: voiceRecordingsLeftAtVendorQuerySchema },
    responses: {
      200: { description: "The recordings left at the vendor", content: { "application/json": { schema: ResponseSchema } } },
      400: errorResponse("Invalid query or cursor"),
      401: errorResponse("Authentication required"),
      403: errorResponse("Caller is not an owner or admin of the organization"),
    },
  });
};
