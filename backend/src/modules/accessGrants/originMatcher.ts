import {
  normalizeWebsiteEmbedOrigin,
} from "../../shared/domain/websiteEmbed.js";
import type { OriginConstraint } from "./domain.js";

export interface OriginMatcher {
  matches(constraint: OriginConstraint, origin: string | null | undefined): boolean;
}

export class DefaultOriginMatcher implements OriginMatcher {
  matches(constraint: OriginConstraint, origin: string | null | undefined): boolean {
    if (constraint.mode === "allow-all") {
      return true;
    }

    const normalizedOrigin = origin ? normalizeWebsiteEmbedOrigin(origin) : null;
    if (!normalizedOrigin) {
      return false;
    }

    const allowedOrigins = constraint.origins
      .map((allowedOrigin) => normalizeWebsiteEmbedOrigin(allowedOrigin))
      .filter((allowedOrigin): allowedOrigin is string => allowedOrigin !== null);
    return allowedOrigins.includes(normalizedOrigin);
  }
}
