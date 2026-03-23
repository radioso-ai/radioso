# Research: Terminal Bootstrap Installer

## Decision 1: Use a root-level plain Node bootstrap module and keep `run-dev.sh` as a thin wrapper

**Decision**: Implement the default local start flow as a repository-root Node 22 ESM script under `scripts/bootstrap/`, with `run-dev.sh` reduced to a thin compatibility wrapper that executes the Node entry point.

**Rationale**:

- The bootstrap must work before any app dependencies are installed, so it cannot depend on `tsx`, TypeScript compilation, or package-manager-installed libraries.
- The current `run-dev.sh` already acts as a de facto entry point, but its workstation-specific `.env` copy behavior is brittle and should be removed rather than expanded.
- A plain Node script can handle interactive prompts, process spawning, file I/O, secret generation, and terminal capability detection with built-in modules only.
- Keeping `run-dev.sh` as a wrapper preserves a familiar command while ensuring the real logic lives in testable, modular code instead of in Bash.

**Alternatives considered**:

- Expand `run-dev.sh` directly into a large Bash installer. Rejected because prompt validation, cross-platform process inspection, ANSI fallback handling, and `.env` merge rules become difficult to test and maintain in shell.
- Put the installer in `backend/` as TypeScript executed with `tsx`. Rejected because the bootstrap would then depend on backend packages being installed before the installer can run.
- Add a new root `package.json` and ship an npm script as the only entry point. Rejected for the first iteration because it introduces package-manager coupling without solving the pre-install bootstrap constraint better than plain Node.

## Decision 2: Treat `backend/.env.example` as the canonical env contract, with bootstrap metadata layered in a focused support module

**Decision**: Keep `backend/.env.example` as the canonical local configuration contract and introduce a dedicated bootstrap support module that maps each key to prompt behavior, secrecy, validation rules, generated defaults, and conditional inclusion.

**Rationale**:

- The repository already points developers to `backend/.env.example`, so replacing it as the source of truth would create drift.
- The example file alone cannot safely encode conditional prompts, secret masking, or whether a missing value should be generated versus requested.
- A focused support module can make prompt and validation logic explicit while still deriving the actual output keys and stable defaults from the checked-in env example.
- This keeps backend runtime validation in `backend/src/app/config/env.ts` separate from the developer-experience logic of the installer.

**Alternatives considered**:

- Parse comments in `.env.example` and infer all prompt behavior dynamically. Rejected because comments are too loose to serve as a durable machine-readable prompt contract.
- Move the canonical env contract into backend runtime code and generate `.env.example` from it. Rejected for this feature because it widens scope and couples runtime parsing to installer-only concerns.
- Hardcode a separate prompt list inside the bootstrap flow. Rejected because it would eventually drift from the example file and violate the goal of a canonical env contract.

## Decision 3: Render ANSI graphics with built-in escape sequences and capability detection, not a heavyweight TUI framework

**Decision**: Implement the themed terminal UI with ANSI escape sequences, Unicode block-friendly pixel art, and explicit no-color fallback logic inside a dedicated terminal presentation module.

**Rationale**:

- The spec requires a pixel-style yellow sun, clouds, and themed prompts, but the installer must also stay usable in limited terminals and before package install.
- Built-in ANSI output keeps startup dependencies at zero and allows exact control over when art appears and how prompts are emphasized.
- A dedicated presentation module can centralize color tokens, art templates, width-aware layout, and reduced-styling fallbacks so decorative output never obscures prompts.
- The required visuals are modest and deterministic; a full-screen TUI framework would add more complexity than value for this flow.

**Alternatives considered**:

- Use a third-party TUI library such as Ink, Blessed, or prompts packages. Rejected because they require dependency installation before bootstrap and increase complexity for a non-product runtime path.
- Keep the flow plain text and omit the art. Rejected because the approved spec explicitly calls for a branded ANSI experience with sun-and-cloud visuals.
- Always print full-color block art without detection. Rejected because the spec requires graceful behavior when ANSI styling or advanced rendering is unavailable.
