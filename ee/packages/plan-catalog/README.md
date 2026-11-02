# @radioso/plan-catalog

The single source of truth for Radioso Cloud plan numbers: prices, quotas, the free/default plan,
the self-serve ceiling, usage-counting weights, the conversation grace share, the conversation
top-up, the managed-service add-on, the model set managed plans run on (`managedModels`),
whether prices include VAT (`taxBehavior`), the provider list prices model spend is estimated at
(`modelListPrices`), and the spend per conversation above which staff are warned
(`conversationSpendFlagEur`). `src/plans.json` holds the data; `src/index.ts` exports typed access
(`PLAN_CATALOG`, `findPlan`, `findModelListPrice`, `formatPrice`) and no runtime validation
library, so a change here is a data edit plus the invariants in `tests/planCatalog.test.ts`.

`modelListPrices` holds each priced model's input and output rate in USD per million tokens, as
providers publish them, and `eurPerUsd`, the rate that turns them into the catalog currency.
Cached input is priced at the full input rate. An invariant requires a price for both
`managedModels` slots, so a managed workspace's spend is never left unpriced; a model run on a
customer's own key may be missing, and the spend estimate counts those calls instead of pricing
them. `conversationSpendFlagEur` (€0.04) is where Planet at full quota drops below a 50% gross
margin.

Stripe prices are referenced by `lookup_key` (`satellite_month`, `topup_300`, …), never by price
id. A price change is a new Stripe price with the key transferred to it; the app needs no config
change. Webhooks resolve a price back to its plan through the Stripe product's `plan` metadata, so
customers grandfathered on an older price still map to the right plan.

`taxBehavior` is the `tax_behavior` of every Stripe price the catalog defines. It is `exclusive`:
catalog numbers are net, and Stripe Tax adds VAT on top at checkout.

The `stripe:sync` script in `@radioso/enterprise-backend-module` turns this catalog into Stripe
products, prices, the customer-portal configuration, and the webhook endpoint, so a price change is
an edit here followed by a sync run. `docs-portal/content/operators/billing-setup.mdx` walks through
it.

## Consumers

- `ee/packages/backend-module/src/billing` serves the catalog at the public `GET /api/v1/plans`
  route, and its `stripe:sync` command makes a Stripe account match it.
- `ee/packages/backend-module/src/usageLimits` seeds one `ee_usage_limit_profiles` row per plan
  and assigns `defaultPlanId` to every new account.
- `ee/packages/backend-module/src/conversationSpend` prices the usage ledger's token counts at
  `modelListPrices` and compares each account's monthly average per metered conversation with
  `conversationSpendFlagEur` for the staff console. `ee/readme.md` ("Conversation spend")
  describes what staff see and the levers for a flagged account.
- `ee/packages/backend-module/src/managedModels` turns `managedModels` into the backend's
  `ManagedModelPolicy`: a workspace on a `models: "managed"` plan with no key of its own for the
  provider it would otherwise use runs `managedModels.chat` for chat and `managedModels.default`
  for rewrite and rerank.
- The Radioso website snapshots `GET /api/v1/plans` for its pricing page, so a plan-numbers change
  here reaches the website without a separate edit there.
