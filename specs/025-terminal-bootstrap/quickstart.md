# Quickstart: Terminal Bootstrap Installer

## Goal

Verify that the repository has one default local start command that handles both first-run setup and normal day-to-day startup from the terminal.

## Default Start Flow

1. From the repository root, run the documented default local start command.
   Command: `./run-dev.sh`
2. Confirm the command opens with the themed ANSI header featuring the pixel-style yellow sun and clouds when the terminal supports styling.
3. Confirm the command begins with preflight checks before attempting to write `backend/.env` or start Docker services.

## Scenario 1: Fresh Machine Setup

1. Remove or rename `backend/.env` if it already exists.
2. Run `./run-dev.sh`.
3. Confirm the installer checks for Docker, `docker compose`, Docker daemon availability, and required local ports.
4. Provide the requested required configuration values.
5. Confirm the installer generates safe defaults and secrets for the remaining supported values.
6. Confirm `backend/.env` is created.
7. Confirm the compose stack starts and the final summary reports the local frontend and backend URLs.

## Scenario 2: Repeat Daily Startup

1. Keep a valid `backend/.env` in place.
2. Run `./run-dev.sh` again.
3. Confirm the installer does not re-ask unchanged required configuration values.
4. Confirm the command proceeds from preflight into compose startup and readiness checks.
5. Confirm the final success output remains concise and themed rather than dumping raw compose logs.

## Scenario 3: Missing Dependency Recovery

1. Run `./run-dev.sh` in an environment where Docker or `docker compose` is unavailable.
2. Confirm the installer exits before writing configuration or starting services.
3. Confirm the output names the exact missing dependency and gives a concrete recovery step.

## Scenario 4: Blocked Port Recovery

1. Occupy one of the required local ports before running the command.
2. Run `./run-dev.sh`.
3. Confirm the installer reports the conflicting port before service startup.
4. Confirm the output explains that startup cannot continue until the conflict is resolved.

## Scenario 5: ANSI Fallback

1. Run `./run-dev.sh` in a terminal with color disabled or limited styling support.
2. Confirm the flow remains understandable without color alone.
3. Confirm prompts, warnings, and recovery guidance still stand out even if decorative styling is reduced.

## Validation Notes

- `run-dev.sh` should remain only as a thin wrapper or compatibility path if it continues to exist.
- `infra/docker-compose.yml` and `infra/docker-compose.dev.yml` should remain the source of truth for service startup.
- `backend/.env.example` should remain aligned with the installer's prompt and default behavior.
- Validation completed with: `node --test tests/bootstrap/*.test.mjs`
