import { z } from 'zod'

/**
 * Spec 1277 (FR-021/FR-050): the frontend proxy's own view of the edge-facts
 * signing secret, shared with the backend (`backend/src/app/config/env.ts`).
 * Only imported from server-side route handlers (`app/api/**\/route.ts`),
 * never from client components.
 */
const edgeEnvSchema = z.object({
  RADIOSO_EDGE_PROOF_SECRET: z.string().min(32).optional(),
})

type EdgeEnv = z.infer<typeof edgeEnvSchema>

const emptyToUndefined = (value: string | undefined): string | undefined => (value ? value : undefined)

let cachedEdgeEnv: EdgeEnv | undefined

/** Reads and validates the edge-facts env vars once per server process. */
export const getEdgeEnv = (): EdgeEnv => {
  if (!cachedEdgeEnv) {
    cachedEdgeEnv = edgeEnvSchema.parse({
      RADIOSO_EDGE_PROOF_SECRET: emptyToUndefined(process.env.RADIOSO_EDGE_PROOF_SECRET),
    })
  }
  return cachedEdgeEnv
}
