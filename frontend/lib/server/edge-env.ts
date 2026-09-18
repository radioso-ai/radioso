import { z } from 'zod'

/**
 * Spec 1277 (FR-021/FR-050): the frontend proxy's own view of the edge-facts
 * signing secret, its trusted-proxy-hop count for `X-Forwarded-For`, and the
 * operator's optional geo header overrides. These four names are shared with
 * the backend (`backend/src/app/config/env.ts`) but set per service, since the
 * frontend and backend each sit their own number of hops behind the load
 * balancer. Only imported from server-side route handlers (`app/api/**\/route.ts`),
 * never from client components.
 */
const lowerCasedHeaderName = z
  .string()
  .min(1)
  .transform((value) => value.toLowerCase())

const edgeEnvSchema = z.object({
  RADIOSO_EDGE_PROOF_SECRET: z.string().min(32).optional(),
  RADIOSO_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  VISITOR_GEO_COUNTRY_HEADER: lowerCasedHeaderName.optional(),
  VISITOR_GEO_REGION_HEADER: lowerCasedHeaderName.optional(),
  VISITOR_GEO_CITY_HEADER: lowerCasedHeaderName.optional(),
})

type EdgeEnv = z.infer<typeof edgeEnvSchema>

const emptyToUndefined = (value: string | undefined): string | undefined => (value ? value : undefined)

let cachedEdgeEnv: EdgeEnv | undefined

/** Reads and validates the edge-facts env vars once per server process. */
export const getEdgeEnv = (): EdgeEnv => {
  if (!cachedEdgeEnv) {
    cachedEdgeEnv = edgeEnvSchema.parse({
      RADIOSO_EDGE_PROOF_SECRET: emptyToUndefined(process.env.RADIOSO_EDGE_PROOF_SECRET),
      RADIOSO_TRUSTED_PROXY_HOPS: emptyToUndefined(process.env.RADIOSO_TRUSTED_PROXY_HOPS),
      VISITOR_GEO_COUNTRY_HEADER: emptyToUndefined(process.env.VISITOR_GEO_COUNTRY_HEADER),
      VISITOR_GEO_REGION_HEADER: emptyToUndefined(process.env.VISITOR_GEO_REGION_HEADER),
      VISITOR_GEO_CITY_HEADER: emptyToUndefined(process.env.VISITOR_GEO_CITY_HEADER),
    })
  }
  return cachedEdgeEnv
}
