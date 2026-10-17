import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import { Router, type RequestHandler, type Response } from "express";

import type { AppDependencies } from "../../server/types.js";
import type { VoiceRecordingPlaybackPort, VoiceRecordingStream } from "../../../modules/voiceChannel/public.js";

import { AppError, badRequest, forbidden, notFound } from "../../../shared/domain/errors.js";
import { acceptWorkspaceIdFromQuery } from "../middleware/acceptWorkspaceIdFromQuery.js";
import { requireWorkspaceSession, type WorkspaceSessionDependencies } from "../middleware/requireWorkspaceSession.js";
import { requireWorkspacePermission } from "../middleware/requirePermission.js";
import { conversationParamsSchema } from "./conversationRouteSchemas.js";

type ConversationRecordingRouteDependencies = WorkspaceSessionDependencies & Pick<AppDependencies, "logger"> & {
  voiceRecordings: VoiceRecordingPlaybackPort;
};

/**
 * Sends the vendor's audio as it arrives. Nothing may cache it, and the response names neither the
 * vendor nor its URL: only the audio and how much of it this is.
 */
const sendRecording = async (
  res: Response,
  recording: VoiceRecordingStream,
  context: { workspaceId: string; conversationId: string; listenerGone: AbortSignal; logger: ConversationRecordingRouteDependencies["logger"] },
): Promise<void> => {
  res.status(recording.status);
  res.setHeader("Content-Type", recording.contentType);
  res.setHeader("Cache-Control", "private, no-store");
  if (recording.contentLength !== undefined) res.setHeader("Content-Length", String(recording.contentLength));
  if (recording.contentRange) res.setHeader("Content-Range", recording.contentRange);
  if (recording.acceptRanges) res.setHeader("Accept-Ranges", recording.acceptRanges);
  try {
    await pipeline(Readable.fromWeb(recording.body as NodeReadableStream<Uint8Array>), res);
  } catch (error) {
    // A listener who closes the player or seeks ends the response early; that is not a failure.
    if (context.listenerGone.aborted) return;
    context.logger.warn(
      { workspaceId: context.workspaceId, conversationId: context.conversationId, errorClass: error instanceof Error ? error.name : typeof error },
      "Voice recording stream ended early",
    );
    res.destroy();
  }
};

/** HEAD would audit a play and send the audio nowhere. */
const refuseHead: RequestHandler = (req, res, next) => {
  if (req.method !== "HEAD") {
    next();
    return;
  }
  res.setHeader("Allow", "GET");
  next(new AppError(405, "method_not_allowed", "Use GET to play a recording."));
};

/**
 * Only the dashboard's own pages may start a play: a browser names where a request came from in
 * `Sec-Fetch-Site`, so a link on another site cannot record an audited play under a teammate's name.
 * A request without it is no browser's.
 */
const requireSameOriginFetch: RequestHandler = (req, _res, next) => {
  const site = req.header("sec-fetch-site");
  next(site === undefined || site === "same-origin" ? undefined : forbidden("A recording plays only from the dashboard."));
};

/**
 * `GET /api/v1/conversations/:conversationId/recording`: a voice conversation's recording, streamed
 * from the vendor for a teammate who may read the workspace's conversations, in a dashboard session
 * (`apiPrincipalRoutePolicy` refuses machine credentials), from the dashboard's own pages. The Inbox
 * plays it in an `<audio>` element, which cannot carry the workspace header, so the workspace may
 * come as a `workspaceId` query selector. The listener's `Range` goes on to the vendor; a vendor that
 * ignores it answers with the whole recording, and a range past the end is the vendor's 416. Every
 * play that sends audio is audited. A listener who goes away before the vendor answers is let go
 * without an answer or a failure.
 */
export const createConversationRecordingRoutes = (dependencies: ConversationRecordingRouteDependencies): Router => {
  const router = Router();
  const workspaceSession = requireWorkspaceSession(dependencies);
  const historyRead = requireWorkspacePermission(dependencies, "workspace.history.read");

  router.get(
    "/:conversationId/recording",
    refuseHead,
    requireSameOriginFetch,
    acceptWorkspaceIdFromQuery,
    workspaceSession,
    historyRead,
    async (req, res, next) => {
      const listener = new AbortController();
      res.on("close", () => {
        if (!res.writableFinished) listener.abort();
      });
      try {
        const params = conversationParamsSchema.safeParse(req.params);
        if (!params.success) {
          next(badRequest("Invalid request params", params.error.flatten()));
          return;
        }
        const { conversationId } = params.data;
        const { workspaceId, userId } = res.locals as { workspaceId: string; userId?: string };
        const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
        const playback = await dependencies.voiceRecordings.play({
          workspaceId,
          conversationId,
          actorUserId: userId ?? null,
          ...(range ? { range } : {}),
          signal: listener.signal,
        });
        // Nobody is left to answer.
        if (playback.kind === "abandoned" || listener.signal.aborted) return;
        if (playback.kind === "not_found") {
          next(notFound("This conversation has no recording."));
          return;
        }
        if (playback.kind === "range_not_satisfiable") {
          res.setHeader("Cache-Control", "private, no-store");
          if (playback.contentRange) res.setHeader("Content-Range", playback.contentRange);
          res.status(416).end();
          return;
        }
        if (playback.kind === "unavailable") {
          next(new AppError(503, "recording_unavailable", "The recording cannot be played right now. Try again later."));
          return;
        }
        await sendRecording(res, playback.recording, { workspaceId, conversationId, listenerGone: listener.signal, logger: dependencies.logger });
      } catch (error) {
        if (listener.signal.aborted) return;
        next(error);
      }
    },
  );

  return router;
};
