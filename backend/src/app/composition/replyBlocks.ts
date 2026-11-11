import { ReplyBlockTurnFactory } from "../../modules/chat/composition.js";
import type { ReplyImageUrls } from "../../modules/chat/contracts/index.js";
import type { DocumentImageEvidenceReader } from "../../modules/documents/contracts/index.js";
import { EvidenceImageAttacher } from "../../modules/retrieval/public.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { Env } from "../config/env.js";
import { REPLY_IMAGE_ROUTE_PATH } from "../http/routes/replyImageRoutes.js";
import { publicApiBaseUrl } from "./publicApiBase.js";

const SMALL_WIDTH = 320;
const LARGE_WIDTH = 640;

/**
 * The served addresses of a reply block's image. Built when a block is presented, never stored,
 * so a stored block survives a change of the address the backend is reached at. They sit on the
 * public backend base (`publicApiBaseUrl`), which a browser loads cross-origin and a messaging
 * provider fetches.
 */
export const createReplyImageUrls = (
  env: Pick<Env, "APP_BASE_URL" | "CONNECTOR_PUBLIC_BASE_URL" | "PORT">,
): ReplyImageUrls => {
  const base = `${publicApiBaseUrl(env)}${REPLY_IMAGE_ROUTE_PATH}`;
  return {
    forImage: (imageId) => {
      const at = (width: number) => `${base}/${encodeURIComponent(imageId)}/${width}`;
      return { src: at(LARGE_WIDTH), srcSet: `${at(SMALL_WIDTH)} ${SMALL_WIDTH}w, ${at(LARGE_WIDTH)} ${LARGE_WIDTH}w` };
    },
  };
};

/**
 * Reply blocks wiring: the grounded answer reads its evidence's stored images through the
 * documents' image rows, and presents the images it picks at the public image route.
 */
export const createReplyBlocksComposition = (input: {
  env: Pick<Env, "APP_BASE_URL" | "CONNECTOR_PUBLIC_BASE_URL" | "PORT">;
  evidenceImages: DocumentImageEvidenceReader;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger?: Pick<AppLogger, "warn">;
}) => {
  const imageUrls = createReplyImageUrls(input.env);
  return {
    imageUrls,
    turnFactory: new ReplyBlockTurnFactory({
      evidenceImages: new EvidenceImageAttacher(input.evidenceImages),
      imageUrls,
      metrics: input.metrics,
      logger: input.logger,
    }),
  };
};
