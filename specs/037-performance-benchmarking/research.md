# Research: Performance Benchmarking

## Decision 1: Keep benchmark definitions and budgets in the repo, but allow heavy execution outside the app process

- **Decision**: Store benchmark profiles, budgets, result rules, and runner code in the Radioso repository while allowing the actual load generation to run from a separate process or runner environment.
- **Rationale**: The source of truth must evolve with the product. Keeping benchmark definitions outside the repo would cause drift and remove them from normal review. Running heavy traffic from outside the app process preserves realistic pressure and avoids distorting server behavior.
- **Alternatives considered**:
  - Full external benchmark project: rejected because profile drift would be likely and the benchmark contract would not move with the product.
  - Run all load generation inside the backend runtime: rejected because it would contaminate production-oriented modules and distort measurements.

## Decision 2: Start with black-box traffic plus bounded database collectors instead of new benchmark APIs

- **Decision**: Measure the first release through HTTP traffic generation and focused PostgreSQL snapshot collectors for queue depth, job age, and related backlog signals.
- **Rationale**: Radioso already persists durable worker state in PostgreSQL. Reading that bounded operational state directly avoids adding benchmark-only production routes before they are justified. It also keeps route files and startup composition responsibility-limited.
- **Alternatives considered**:
  - Add benchmark routes immediately: rejected because they would enlarge the production surface without first proving black-box observation is insufficient.
  - Measure only top-line HTTP latency: rejected because Radioso’s worker backlog and queue drain behavior are core enterprise-relevance signals.

## Decision 3: Model benchmark workloads as named profile families with safety tiers

- **Decision**: Define benchmark profiles in named families: API-only, chat, ingestion, mixed, stress, and soak, and classify each profile by allowed environment class.
- **Rationale**: This keeps routine performance checks safe and fast while still supporting limit-finding exercises. It also prevents engineers from improvising workloads with inconsistent shapes.
- **Alternatives considered**:
  - One generic benchmark command with arbitrary flags only: rejected because it would encourage one-off runs that are hard to compare.
  - Stress testing only: rejected because everyday regression detection needs lighter, repeatable profiles too.

## Decision 4: Store run artifacts and machine-specific baselines under `.context/performance-runs/`

- **Decision**: Save benchmark results, local baselines, and machine-local comparisons under `.context/performance-runs/`.
- **Rationale**: Results can be large, noisy, and environment-specific. Keeping them gitignored prevents dirty-worktree churn while still making them available to the current workspace and cooperating agents.
- **Alternatives considered**:
  - Commit every run result: rejected because benchmark artifacts will quickly become noisy and misleading across machines.
  - Keep no saved results: rejected because baseline comparison is a core requirement.

## Decision 5: Treat budgets as the durable shared contract, and baselines as environment-specific evidence

- **Decision**: Commit the shared workload definitions and budget rules, but allow accepted baseline result snapshots to remain environment-class-specific artifacts.
- **Rationale**: Budgets define what the team accepts. Baselines are supporting evidence, but a laptop baseline and a staging baseline should not be conflated. This split keeps the durable contract reviewable while permitting environment-aware comparisons.
- **Alternatives considered**:
  - Commit one universal golden baseline: rejected because hardware, provider latency, and environment class produce too much natural variation.
  - Use no budgets and compare only relative changes: rejected because a relative comparison alone cannot say whether the app is actually good enough.

## Decision 6: Prioritize benchmark trustworthiness over dashboards in the first release

- **Decision**: Focus the first release on profile correctness, reproducibility, collector safety, and bounded textual reports rather than a new dashboard UI.
- **Rationale**: The product need is engineering decision-making, not immediate visualization polish. A trustworthy CLI or script-driven report is enough to unlock performance work, while a dashboard would add scope before the benchmark semantics are proven.
- **Alternatives considered**:
  - Build a dashboard first: rejected because it adds frontend scope before the benchmark model is stable.
  - Defer reporting and produce raw logs only: rejected because engineers need clear verdicts, not only raw output.
