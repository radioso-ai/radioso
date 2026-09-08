import type { Request, Response } from "express";
import multer from "multer";

import { agentInputThemeSchema } from "../../../modules/agents/public.js";
import { badRequest } from "../../../shared/domain/errors.js";
import { asError } from "../../../shared/errors/asError.js";

export const assistantThemeSchema = agentInputThemeSchema;

const ASSISTANT_LOGO_MAX_BYTES = 1024 * 1024;
export const ASSISTANT_LOGO_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const createAssistantLogoUploadHandler = () => {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: ASSISTANT_LOGO_MAX_BYTES,
    },
  });

  return (req: Request, res: Response) =>
    new Promise<void>((resolve, reject) => {
      upload.single("logo")(req, res, (error) => {
        if (!error) {
          resolve();
          return;
        }
        if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
          reject(badRequest("Uploaded assistant logo exceeds maximum size"));
          return;
        }
        reject(asError(error));
      });
    });
};

/** The stored logo descriptor, narrowed to what serving the bytes needs. */
interface ServableAssistantLogo {
  bucket: string;
  objectPath: string;
  generation?: string | null;
  mimeType: string;
}

/**
 * Writes a stored assistant logo to the response. Both the visitor route and the
 * operator route serve the same bytes, so the content-type narrowing that keeps an
 * unexpected stored mime type from being sniffed lives here rather than in either route.
 */
export const sendAssistantLogo = async (input: {
  res: Response;
  logo: ServableAssistantLogo;
  documentStorage: { read(input: { bucket: string; objectPath: string; generation: string | null }): Promise<Buffer> };
  cacheControl: string;
}): Promise<void> => {
  const buffer = await input.documentStorage.read({
    bucket: input.logo.bucket,
    objectPath: input.logo.objectPath,
    generation: input.logo.generation ?? null,
  });
  input.res.setHeader("Content-Type", ASSISTANT_LOGO_MIME_TYPES.has(input.logo.mimeType) ? input.logo.mimeType : "application/octet-stream");
  input.res.setHeader("Content-Disposition", 'inline; filename="logo"');
  input.res.setHeader("Cache-Control", input.cacheControl);
  input.res.status(200).send(buffer);
};
