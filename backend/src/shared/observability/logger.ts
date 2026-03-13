import type { RequestHandler } from "express";
import pino from "pino";
import { pinoHttp } from "pino-http";

export const createLogger = (level = process.env.NODE_ENV === "production" ? "info" : "debug") =>
  pino({ level });

export type AppLogger = ReturnType<typeof createLogger>;

export const createHttpLogger = (logger: AppLogger): RequestHandler =>
  pinoHttp({
    logger,
    customProps: (req: { id?: string | number }) => ({
      requestId: req.id,
    }),
  }) as unknown as RequestHandler;
