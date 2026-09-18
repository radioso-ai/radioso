/**
 * FR-024 (spec 1277): resolves country/region/city from the well-known geo
 * headers an edge (a CDN, a cloud load balancer, or a self-hosted reverse
 * proxy) stamps. This is a port so a future GeoIP-database adapter can
 * replace the header adapter in composition without touching a caller —
 * conversations, visitors, and the drawer only ever see the resolved
 * `{ country, region, city }`, never a header name.
 */
export interface VisitorGeoResolution {
  country: string | null;
  region: string | null;
  city: string | null;
}

export interface VisitorGeoResolver {
  resolve(geoHeaders: Record<string, string>): VisitorGeoResolution;
}

interface HeaderVisitorGeoResolverConfig {
  /** `VISITOR_GEO_COUNTRY_HEADER` (already lower-cased by env parsing), when set. */
  countryHeaderOverride?: string | null;
  /** `VISITOR_GEO_REGION_HEADER`, when set. */
  regionHeaderOverride?: string | null;
  /** `VISITOR_GEO_CITY_HEADER`, when set. */
  cityHeaderOverride?: string | null;
}

const ISO_ALPHA_2 = /^[A-Za-z]{2}$/u;

const normalizeCountry = (value: string | undefined | null): string | null => {
  if (!value) return null;
  const upper = value.toUpperCase();
  return ISO_ALPHA_2.test(upper) ? upper : null;
};

const nonEmpty = (value: string | undefined | null): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/**
 * Header names are protocol identifiers, not product vocabulary (CLAUDE.md).
 * Precedence (FR-024): an operator's `VISITOR_GEO_*_HEADER` override, then
 * GCP, then Cloudflare, then Vercel, then App Engine — resolved independently
 * per field, since no single source supplies all three everywhere (e.g.
 * Cloudflare supplies only country). GCP's `x-client-region` carries an ISO
 * 3166-2 `COUNTRY-REGION` code (e.g. `US-CA`); its prefix is the country.
 */
export class HeaderVisitorGeoResolver implements VisitorGeoResolver {
  constructor(private readonly config: HeaderVisitorGeoResolverConfig = {}) {}

  resolve(geoHeaders: Record<string, string>): VisitorGeoResolution {
    const overrideCountry = this.config.countryHeaderOverride ? geoHeaders[this.config.countryHeaderOverride] : undefined;
    const overrideRegion = this.config.regionHeaderOverride ? geoHeaders[this.config.regionHeaderOverride] : undefined;
    const overrideCity = this.config.cityHeaderOverride ? geoHeaders[this.config.cityHeaderOverride] : undefined;

    const gcpRegion = nonEmpty(geoHeaders["x-client-region"]);
    const gcpCountry = gcpRegion?.split("-", 1)[0];

    const country = normalizeCountry(overrideCountry)
      ?? normalizeCountry(gcpCountry)
      ?? normalizeCountry(geoHeaders["cf-ipcountry"])
      ?? normalizeCountry(geoHeaders["x-vercel-ip-country"])
      ?? normalizeCountry(geoHeaders["x-appengine-country"]);

    const region = nonEmpty(overrideRegion)
      ?? gcpRegion
      ?? nonEmpty(geoHeaders["x-vercel-ip-country-region"]);

    const city = nonEmpty(overrideCity)
      ?? nonEmpty(geoHeaders["x-client-city"])
      ?? nonEmpty(geoHeaders["x-vercel-ip-city"]);

    return { country, region, city };
  }
}
