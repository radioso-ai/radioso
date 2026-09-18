import type { Env } from "../config/env.js";
import { HeaderVisitorGeoResolver, type VisitorGeoResolver } from "../../shared/domain/visitorGeoResolver.js";

/**
 * Default `VisitorGeoResolver` wiring (spec 1277, FR-024): the header adapter,
 * configured from the operator's optional `VISITOR_GEO_*_HEADER` overrides. A
 * future GeoIP-database adapter replaces only this factory — every caller
 * depends on the port.
 */
export const createDefaultVisitorGeoResolver = (
  env: Pick<Env, "VISITOR_GEO_COUNTRY_HEADER" | "VISITOR_GEO_REGION_HEADER" | "VISITOR_GEO_CITY_HEADER">,
): VisitorGeoResolver => new HeaderVisitorGeoResolver({
  countryHeaderOverride: env.VISITOR_GEO_COUNTRY_HEADER ?? null,
  regionHeaderOverride: env.VISITOR_GEO_REGION_HEADER ?? null,
  cityHeaderOverride: env.VISITOR_GEO_CITY_HEADER ?? null,
});
