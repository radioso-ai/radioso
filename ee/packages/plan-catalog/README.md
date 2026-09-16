# @radioso/plan-catalog

The single source of truth for Radioso Cloud plan numbers: prices, quotas, the free/default plan,
the self-serve ceiling, usage-counting weights, the conversation top-up, the managed-service
add-on, and the model set managed plans run on (`managedModels`). `src/plans.json` holds the data; `src/index.ts` exports typed access (`PLAN_CATALOG`,
`findPlan`, `formatPrice`) and no runtime validation library, so a change here is a data edit plus
the invariants in `tests/planCatalog.test.ts`.

Stripe prices are referenced by `lookup_key` (`satellite_month`, `topup_300`, …), never by price
id. A price change is a new Stripe price with the key transferred to it; the app needs no config
change. Webhooks resolve a price back to its plan through the Stripe product's `plan` metadata, so
customers grandfathered on an older price still map to the right plan.

## Consumers

- `ee/packages/backend-module/src/billing` serves the catalog at the public `GET /api/v1/plans`
  route.
- `ee/packages/backend-module/src/usageLimits` seeds one `ee_usage_limit_profiles` row per plan
  and assigns `defaultPlanId` to every new account.
- `ee/packages/backend-module/src/managedModels` turns `managedModels` into the backend's
  `ManagedModelPolicy`: a workspace on a `models: "managed"` plan with no key of its own for the
  provider it would otherwise use runs `managedModels.chat` for chat and `managedModels.default`
  for rewrite and rerank.
- The Radioso website snapshots `GET /api/v1/plans` for its pricing page, so a plan-numbers change
  here reaches the website without a separate edit there.
