import { HeaderVisitorGeoResolver, type VisitorGeoResolver } from "../../shared/domain/visitorGeoResolver.js";

/**
 * Default `VisitorGeoResolver` wiring (spec 1277, FR-024): the well-known
 * header-precedence adapter. A future GeoIP-database adapter replaces only
 * this factory — every caller depends on the port.
 */
export const createDefaultVisitorGeoResolver = (): VisitorGeoResolver => new HeaderVisitorGeoResolver();
