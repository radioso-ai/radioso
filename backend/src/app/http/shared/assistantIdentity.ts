import type { Request, Response } from "express";
import multer from "multer";
import { z } from "zod";

import { badRequest } from "../../../shared/domain/errors.js";
import { asError } from "../../../shared/errors/asError.js";

export const assistantThemeSchema = z.object({
  brand: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  brandText: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  surface: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  text: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});

export const ASSISTANT_LOGO_MAX_BYTES = 1024 * 1024;
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
