import type { AnswerSupportPolicy } from "../../settings/domain/retrievalSettings.js";

export const shouldReplaceUnsupportedSegments = (policy: AnswerSupportPolicy): boolean => policy === "strict";

export const shouldPreserveUnsupportedSegments = (policy: AnswerSupportPolicy): boolean =>
  policy === "warn" || policy === "off";
