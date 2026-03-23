# Feature Specification: Terminal Bootstrap Installer

**Feature Branch**: `025-terminal-bootstrap`  
**Created**: 2026-03-23  
**Status**: Draft  
**Input**: User description: "Create a terminal-first installer that checks Docker and other crucial dependencies, prompts for required environment variables, generates safe defaults and secrets, starts the Docker stack with sensible configuration, gives clear status and recovery guidance without requiring a browser setup flow, and presents a themed ANSI terminal UI with a pixel-style yellow sun and clouds."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Start Radioso From One Default Command (Priority: P1)

A developer can run a single default terminal command to start Radioso locally, whether the machine is fresh or already configured, without needing to choose between separate onboarding and day-to-day startup flows.

**Why this priority**: The feature only provides full value if the repository has one obvious way to start the app. Making setup and normal startup the same command removes ambiguity and reduces maintenance drift.

**Independent Test**: Can be fully tested by running the default command on both a fresh machine without a prepared `backend/.env` and a previously configured machine, then confirming that the command either gathers missing setup inputs or proceeds directly to startup and reaches reachable local services.

**Acceptance Scenarios**:

1. **Given** a developer has cloned the repository and Docker is available, **When** the developer runs the default local start command, **Then** the installer checks prerequisites, asks for required configuration values, prepares local configuration, starts the stack, and reports the local URLs to use.
2. **Given** a developer has already completed setup once, **When** the developer runs the same default local start command again, **Then** the installer detects the existing valid configuration, skips unnecessary prompts, and proceeds directly to startup and health verification.
3. **Given** a required dependency is missing or unavailable, **When** the developer runs the default local start command, **Then** the installer stops before changing configuration, explains the exact blocker, and tells the developer how to recover.

---

### User Story 2 - Configure Only What Matters (Priority: P2)

A developer can provide only the environment values that are actually required for the selected local setup while the installer generates safe defaults and secrets for everything else that should not need manual decision-making.

**Why this priority**: Most setup friction comes from being asked for low-value choices or from copying configuration by hand. Reducing the questionnaire to the minimum improves successful first-run completion.

**Independent Test**: Can be fully tested by running the default command with different provider and storage choices, confirming that only relevant prompts appear when setup is needed, and verifying that the resulting local configuration includes generated defaults for all omitted values.

**Acceptance Scenarios**:

1. **Given** the developer selects the default provider path, **When** the installer gathers configuration, **Then** it requests only the keys and values necessary for that path and fills in all supported default settings that do not require user judgment.
2. **Given** the developer leaves a required value blank or enters an invalid value, **When** the installer validates the response, **Then** it explains the problem in plain language and asks again before writing configuration.
3. **Given** the developer runs the default command after valid configuration already exists, **When** no setup choices have changed, **Then** the command does not force the developer back through the questionnaire before starting the stack.
4. **Given** the developer needs optional capabilities such as external document storage, **When** the installer detects that the capability is enabled, **Then** it asks for the additional required values for that capability and no others.

---

### User Story 3 - Recover From Setup Problems Quickly (Priority: P3)

A developer can understand why setup failed and what to do next because the installer reports failed checks, blocked ports, unreachable services, and startup health status in clear terminal output instead of raw tool noise.

**Why this priority**: A setup script that fails opaquely creates support burden and makes new contributors distrust the local environment.

**Independent Test**: Can be fully tested by simulating blocked ports, stopped container runtime, invalid credentials, and unhealthy services, then confirming that the installer exits with actionable guidance for each case.

**Acceptance Scenarios**:

1. **Given** one of the required local ports is already in use, **When** the installer performs preflight checks, **Then** it identifies the blocked port before startup and tells the developer which service cannot proceed until the conflict is resolved.
2. **Given** the container runtime is installed but not running, **When** the installer begins dependency checks, **Then** it clearly distinguishes that state from a missing installation and tells the developer to start the runtime before retrying.
3. **Given** service startup begins but one or more services never become healthy, **When** the installer waits for readiness, **Then** it reports which service failed readiness and what logs or next step the developer should inspect.

---

### User Story 4 - Enjoy A Clear Branded Terminal Experience (Priority: P3)

A developer sees a polished terminal interface with themed colors, a pixel-style yellow sun and clouds, and easy-to-scan prompts so setup feels intentional instead of like a raw shell script dump.

**Why this priority**: The guided install flow is user-facing software. The visual presentation affects confidence, readability, and perceived quality even though it is not the primary functional path.

**Independent Test**: Can be fully tested by running the installer in a color-capable terminal, confirming that the intro art and prompt styling render consistently, and verifying that the flow remains readable when visual effects are unavailable or disabled.

**Acceptance Scenarios**:

1. **Given** the developer runs the installer in a terminal that supports ANSI styling, **When** the bootstrap flow starts, **Then** the installer presents a themed introduction that includes a pixel-style yellow sun and clouds before the first prompt.
2. **Given** the developer proceeds through setup, **When** prompts, warnings, and success messages are shown, **Then** the installer uses consistent themed colors and formatting that make the current step and important actions easy to distinguish.
3. **Given** the developer runs the installer in a terminal with limited or disabled styling support, **When** the bootstrap flow renders, **Then** the installer remains readable and fully usable without relying on color alone.

### Edge Cases

- What happens when the repository already contains a `backend/.env` with partial or outdated values?
- What happens when the developer cancels setup halfway through after some but not all answers are collected?
- How does the installer behave when Docker is present but `docker compose` support is unavailable?
- What happens when the default ports for the frontend, backend, or database are already occupied?
- How does the installer handle a generated secret or entered value that contains characters requiring escaping in an environment file?
- What happens when service startup fails after the configuration file has been written successfully?
- How does the installer handle optional integrations that are disabled in one run and enabled in a later run?
- How does the installer behave when the user's terminal does not support ANSI colors or renders block-art characters poorly?

## Constitution Constraints *(mandatory)*

- Implementation MUST NOT begin until this spec is approved.
- Work MUST NOT start without a written, approved spec.
- Backend MUST be implemented in Node.js and frontend MUST be implemented in React.
- Database MUST be PostgreSQL with `pgvector` for embeddings and vector search.
- LLM integrations MUST use GPT-5.2 as the default provider.
- Backend development MUST follow TDD: tests written and failing before implementation.
- Secrets and keys MUST be stored in `.env` and never committed; `.env.example` MUST be updated.
- Customer data MUST be protected with least-privilege access and secure transmission.
- Admin-facing pages MUST use the shared dark theme and existing design tokens.
- Features MUST preserve modular boundaries between transport, orchestration, domain logic, and persistence.
- Specs MUST identify files or modules that should remain responsibility-limited rather than absorb new concerns.

## Architecture Constraints *(mandatory)*

- **Boundary Rule**: The bootstrap entry point owns terminal interaction, themed presentation, and progress reporting; a dedicated preflight layer owns dependency and machine checks; a configuration layer owns prompt flow and environment-file materialization; and existing container orchestration assets remain the source of truth for service startup behavior.
- **Encapsulation Rule**: Existing Docker Compose definitions must remain responsible for service topology and runtime wiring. Backend runtime configuration parsing must remain responsible for validating application environment values at app startup, not for driving the interactive installer itself.
- **New Seams Required**: Introduce a focused bootstrap workflow boundary for terminal setup, a reusable preflight-check surface for dependency and port validation, a configuration questionnaire boundary that can derive required prompts from the canonical environment contract without scattering prompt rules across ad hoc scripts, and a terminal presentation boundary for themed art and message styling.
- **Anti-Goals**: Do not require a browser-based `/setup` experience for successful local installation. Do not hardcode one developer's workstation paths or assume an existing local `.env` source. Do not print raw compose output as the primary user guidance. Do not expand application runtime modules into terminal-UI orchestration logic. Do not let decorative output obscure prompt clarity or failure recovery.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a terminal-first command that serves as the default entry point for preparing and starting the local development stack from the repository root.
- **FR-002**: System MUST check for the presence of required local dependencies before attempting configuration or startup.
- **FR-003**: System MUST distinguish between a dependency that is not installed and a dependency that is installed but unavailable to use.
- **FR-004**: System MUST verify that the local container runtime can execute compose-based startup before attempting to start services.
- **FR-005**: System MUST verify that the local ports required for the local stack are available before startup and report conflicts clearly.
- **FR-006**: System MUST create local backend configuration from the repository's canonical environment contract rather than from a workstation-specific source file.
- **FR-007**: System MUST prompt the developer only for configuration values that are required for the selected local setup path.
- **FR-008**: System MUST generate safe default values for secrets and non-sensitive configuration where manual entry is unnecessary.
- **FR-009**: System MUST validate entered configuration values before writing them to disk.
- **FR-010**: System MUST preserve existing valid local configuration values on repeat runs unless the developer explicitly chooses to replace them.
- **FR-011**: System MUST avoid persisting partially completed configuration when the bootstrap flow is cancelled or fails before validation completes.
- **FR-012**: System MUST write the resulting local configuration into the repository's ignored local environment file.
- **FR-013**: System MUST update the canonical example environment contract when the bootstrap flow introduces new required configuration inputs or generated defaults.
- **FR-014**: System MUST start the local stack using the repository's compose configuration after preflight and configuration succeed.
- **FR-015**: System MUST wait for local services to reach a healthy or ready state and report the final outcome in clear terminal output.
- **FR-016**: System MUST report the local application URLs and any immediate next steps after a successful bootstrap run.
- **FR-017**: System MUST exit with actionable recovery guidance when a preflight check, configuration validation, or startup readiness check fails.
- **FR-018**: System MUST support repeatable local setup runs without requiring developers to manually delete containers, volumes, or environment files between attempts.
- **FR-019**: System MUST keep optional setup paths, such as external document storage or alternate providers, gated behind explicit prompts so the default setup remains minimal.
- **FR-020**: System MUST keep bootstrap logging understandable for first-time developers by summarizing progress, warnings, and failures in plain language.
- **FR-021**: System MUST protect secret values from being echoed back in terminal output after entry.
- **FR-022**: System MUST make the default entry command suitable for both first-run setup and routine day-to-day local startup.
- **FR-023**: System MUST avoid routing developers through redundant setup prompts when the existing configuration is still valid for the default startup path.
- **FR-024**: System MUST replace or reduce legacy local-start scripts so the repository presents one clear default way to start the app locally.
- **FR-025**: System MUST present a themed terminal interface for the default command rather than a plain unstyled script transcript.
- **FR-026**: System MUST include a pixel-style yellow sun and clouds in the terminal introduction or header shown at the start of setup or startup.
- **FR-027**: System MUST use consistent visual treatment to distinguish prompts, warnings, errors, progress, and success states throughout the terminal flow.
- **FR-028**: System MUST remain fully usable when ANSI color support or advanced terminal rendering is unavailable.
- **FR-029**: System MUST ensure decorative output does not hide required prompts, secret entry, validation feedback, or recovery instructions.
- **FR-030**: System MUST keep startup orchestration, configuration collection, and terminal presentation testable through isolated preflight, questionnaire, environment-writing, startup status, and presentation behavior checks.

### UI Tasks

- The terminal installer must open with a branded ANSI header that includes a pixel-style yellow sun and clouds.
- The terminal flow must use clear visual hierarchy so the current step, prompt text, helper text, and recovery actions are easy to scan.
- The terminal flow must visually distinguish warnings, validation errors, and success states with consistent themed colors.
- The terminal prompts must remain legible and understandable even when ANSI styling is reduced or unavailable.
- The terminal flow must avoid clutter by showing decorative art at intentional moments rather than before every prompt.

### Key Entities *(include if feature involves data)*

- **Bootstrap Session**: The developer's single guided setup run, including preflight checks, prompt responses, environment preparation, startup, and final status reporting.
- **Default Start Command**: The single repository-supported terminal entry point used for both first-run setup and routine local startup.
- **Preflight Check Result**: The outcome for one prerequisite or machine-state validation, including pass/fail state, human-readable explanation, and suggested recovery action.
- **Configuration Questionnaire**: The ordered set of prompts and validations used to collect only the values required for the chosen local setup path.
- **Local Environment Contract**: The canonical set of environment keys, defaults, generated values, and validation rules used to create the local backend environment file.
- **Startup Readiness Report**: The summarized result of local stack startup, including service health, reachable URLs, and any unresolved warnings or failures.
- **Terminal Presentation Theme**: The rules for visual styling, art, message emphasis, and fallback rendering used to make the bootstrap flow polished without reducing clarity.

## Assumptions

- The default local development path continues to use the repository's existing Docker Compose topology for the database, backend, and frontend.
- OpenAI remains the default provider path and therefore the default guided setup should collect an OpenAI API key unless the developer explicitly chooses a different supported provider path.
- The canonical ignored local environment file remains `backend/.env`.
- Existing contributors should use the same default command for routine local startup, refresh, and repair without expecting destructive cleanup of containers or persisted database volumes.
- The first version of this feature targets local developer onboarding and recovery; it does not attempt to provision cloud infrastructure or production deployment environments.
- The first version of this feature remains terminal-only and does not depend on any browser-only setup experience or visual installer.
- The graphical treatment is part of the terminal experience itself and must degrade gracefully in terminals with limited styling support.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In bootstrap integration tests, 100% of fresh-run scenarios with all required dependencies available complete local configuration creation and reach a reported ready state without manual file editing.
- **SC-002**: In preflight failure tests, 100% of missing-dependency, stopped-runtime, and blocked-port scenarios exit before service startup and include a recovery message naming the exact blocker.
- **SC-003**: In configuration-flow tests, 100% of invalid or incomplete required responses are rejected before the local environment file is written.
- **SC-004**: In repeat-run tests, 100% of previously valid local configuration values are preserved unless the developer explicitly opts to change them.
- **SC-005**: In startup-readiness tests, 100% of unhealthy-service scenarios identify the failing service and direct the developer to the next diagnostic action.
- **SC-006**: In documentation-free usability review of the terminal flow, a new developer can complete default local setup and reach the reported local app URL in under 10 minutes.
- **SC-007**: In repeat-start tests on already configured machines, 100% of normal local startup runs reach service startup without re-asking unchanged required configuration values.
- **SC-008**: In terminal presentation review, 100% of default command runs in ANSI-capable terminals display the themed header with the sun-and-cloud art before configuration or startup progress begins.
- **SC-009**: In accessibility and fallback checks, 100% of required prompts, warnings, and recovery instructions remain understandable when color is unavailable or disabled.
