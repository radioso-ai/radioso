import type { NextFunction, Request, RequestHandler, Response } from "express";
import multer from "multer";
import { z } from "zod";

import type { AuthenticatedPrincipal } from "../../../modules/account/services/accountAccessService.js";
import {
  VISITOR_IMAGE_LIMITS,
  recordVisitorImageUpload,
  type VisitorImageAvailability,
  type VisitorImageOwner,
  type VisitorImageRejection,
  type VisitorImageUploadResult,
} from "../../../modules/visitorImages/public.js";
import { AppError, badRequest, isStructuredAppError } from "../../../shared/domain/errors.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { isLocaleTag } from "../../../shared/domain/locale.js";

/** The multipart field the photo travels in. */
const VISITOR_IMAGE_FILE_FIELD = "image";

/** The form fields an upload may carry beside the photo. */
export const visitorImageUploadFieldsSchema = z.object({
  /** The language the agent writes the photo's reading in; the agent's default when absent. */
  locale: z.string().trim().max(35).refine(isLocaleTag, "a BCP 47 language tag").optional(),
}).strict();

const imageTooLarge = (): AppError =>
  new AppError(413, "image_too_large", `An image may be at most ${VISITOR_IMAGE_LIMITS.maxUploadBytes / (1024 * 1024)} MiB.`);

const REJECTIONS: Readonly<Record<VisitorImageRejection, () => AppError>> = {
  unsupported_type: () => new AppError(415, "unsupported_image_type", "Send a JPEG, PNG or WebP image."),
  too_large: imageTooLarge,
  too_many_pixels: () => new AppError(413, "image_too_many_pixels", "The image has too many pixels. Send a smaller one."),
};

/** The error an upload's refusal answers with. */
export const visitorImageUploadRejection = (reason: VisitorImageRejection): AppError => REJECTIONS[reason]();

/** What an accepted upload answers: the id to send with the message, and whether the agent could read it. */
export const presentVisitorImageUpload = (result: Extract<VisitorImageUploadResult, { kind: "accepted" }>) => ({
  id: result.id,
  readingStatus: result.readingStatus,
});

const MULTER_LIMITS = {
  fileSize: VISITOR_IMAGE_LIMITS.maxUploadBytes,
  files: 1,
  fields: 2,
  parts: 3,
  fieldSize: 256,
  fieldNameSize: 32,
} as const;

/**
 * Buffers the one photo in memory, bounded by size and by the number of parts and fields, after
 * auth, the agent check and the rate limits have run. Any other part shape is a 400; a photo over
 * the raw cap is a 413 counted as rejected for size.
 */
export const visitorImageMultipart = (metrics: Pick<MetricsRegistry, "incrementCounter"> | null): RequestHandler => {
  const upload = multer({ storage: multer.memoryStorage(), limits: MULTER_LIMITS }).single(VISITOR_IMAGE_FILE_FIELD);
  return (req: Request, res: Response, next: NextFunction) => {
    upload(req, res, (error: unknown) => {
      if (!error) {
        if (!req.file) {
          next(badRequest(`Send the image as the multipart field "${VISITOR_IMAGE_FILE_FIELD}"`));
          return;
        }
        const fields = visitorImageUploadFieldsSchema.safeParse(req.body ?? {});
        if (!fields.success) {
          next(badRequest("Invalid image upload fields", fields.error.flatten()));
          return;
        }
        req.body = fields.data;
        next();
        return;
      }
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        recordVisitorImageUpload(metrics, "rejected_size");
        next(imageTooLarge());
        return;
      }
      if (error instanceof multer.MulterError) {
        next(badRequest(`Send one image as the multipart field "${VISITOR_IMAGE_FILE_FIELD}"`));
        return;
      }
      next(badRequest("The upload is not valid multipart form data"));
    });
  };
};

const AVAILABILITY_ERRORS = {
  disabled: "This agent does not accept images.",
  model_cannot_read: "This agent's chat model cannot read images.",
  agent_not_found: "This agent does not accept images.",
} as const;

/**
 * Refuses the upload, before its body is read, unless the agent takes photos now: the operator
 * turned them on and its chat model reads images. `agentOf` names the agent from the request.
 */
export const requireVisitorImagesAvailable = (deps: {
  availability: VisitorImageAvailability;
  metrics: Pick<MetricsRegistry, "incrementCounter"> | null;
  agentOf: (req: Request, res: Response) => { workspaceId: string; agentId: string } | null;
}): RequestHandler => async (req, res, next) => {
  try {
    const subject = deps.agentOf(req, res);
    const availability = subject ? await deps.availability.forAgent(subject) : "agent_not_found";
    if (availability === "available") {
      next();
      return;
    }
    recordVisitorImageUpload(deps.metrics, "disabled");
    next(new AppError(404, "visitor_images_unavailable", AVAILABILITY_ERRORS[availability]));
  } catch (error) {
    next(error);
  }
};

/** Counts an upload the rate limiter refused, then passes the refusal on. */
export const countingRateLimitRefusals = (
  limiters: readonly RequestHandler[],
  metrics: Pick<MetricsRegistry, "incrementCounter"> | null,
): RequestHandler[] => limiters.map((limiter) => (req, res, next) => {
  return limiter(req, res, (error?: unknown) => {
    if (isStructuredAppError(error) && error.statusCode === 429) recordVisitorImageUpload(metrics, "rate_limited");
    next(error);
  });
});

/**
 * Sends a stored photo: always the JPEG the upload re-encoded, never cached, never sniffed into
 * another type, and sandboxed so a browser opening it directly runs nothing.
 */
export const sendVisitorImage = (res: Response, bytes: Buffer): void => {
  res.setHeader("Content-Type", "image/jpeg");
  res.setHeader("Content-Length", String(bytes.length));
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'");
  res.setHeader("Content-Disposition", "inline; filename=\"image.jpg\"");
  res.status(200).send(bytes);
};

/**
 * Who an authenticated caller's photos belong to: the API credential that sent them, or the
 * signed-in user. Never the account: two credentials of one workspace cannot send each other's.
 */
export const authenticatedVisitorImageOwner = (principal: AuthenticatedPrincipal | undefined): VisitorImageOwner | null => {
  if (principal?.type === "personal_api_credential" || principal?.type === "service_account_credential") {
    return { kind: "api_credential", id: principal.credentialId };
  }
  if (principal?.type === "session_user") return { kind: "user", id: principal.userId };
  return null;
};

/** A public chat visitor's photos belong to their public session. */
export const publicVisitorImageOwner = (chatSessionId: string): VisitorImageOwner => ({ kind: "public_session", id: chatSessionId });
