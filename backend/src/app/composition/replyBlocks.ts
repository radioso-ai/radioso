import { ReplyBlockTurnFactory, SkillResultReplyBlocks } from "../../modules/chat/composition.js";
import type { DocumentImageEvidenceReader } from "../../modules/documents/contracts/index.js";
import { EvidenceImageAttacher } from "../../modules/retrieval/public.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { Env } from "../config/env.js";
import { createReplyImageUrls } from "../http/routes/replyImageAddress.js";
import { publicApiBaseUrl } from "./publicApiBase.js";

/**
 * Reply blocks wiring: the grounded answer reads its evidence's stored images through the
 * documents' image rows, a skill-result reply builds cards from the skill's records, and both
 * present the images they pick at the public image route.
 */
export const createReplyBlocksComposition = (input: {
  env: Pick<Env, "APP_BASE_URL" | "CONNECTOR_PUBLIC_BASE_URL" | "PORT">;
  evidenceImages: DocumentImageEvidenceReader;
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger?: Pick<AppLogger, "warn">;
}) => {
  // On the public backend base, which a browser loads cross-origin and a messaging provider fetches.
  const imageUrls = createReplyImageUrls(publicApiBaseUrl(input.env));
  return {
    imageUrls,
    turnFactory: new ReplyBlockTurnFactory({
      evidenceImages: new EvidenceImageAttacher(input.evidenceImages),
      imageUrls,
      metrics: input.metrics,
      logger: input.logger,
    }),
    skillResults: new SkillResultReplyBlocks({ imageUrls, metrics: input.metrics }),
  };
};
