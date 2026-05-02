# Quickstart: Modular Extension Points

Use this checklist to validate the feature after implementation.

## 1. Default Build

Run the backend default build.

```bash
cd backend
npm run build
```

Expected result: the build succeeds without installing or configuring optional modules.

## 2. Focused Backend Tests

Run the focused tests for composition, module registration, and capability policy.

```bash
cd backend
npm run test:composition
```

Expected result: tests prove default composition works, duplicate registration is rejected, optional test modules can register through a supported extension point, and the default capability policy allows current behavior.

## 3. Default Runtime Smoke

Start the local stack using the normal development flow.

```bash
./run-dev.sh
```

Expected result: the app starts with default modules only, and existing account, workspace, document ingestion, retrieval, chat, settings, API, SDK, and MCP flows remain available.

## 4. Capability Denial Regression

Run the focused test that injects a stricter capability policy.

Expected result: the guarded action is denied before mutation, the response is predictable, and no assistant/chat response string is hard-coded for the denial.

## 5. Documentation Review

Read the extension model documentation.

Expected result: the documentation names at least five extension categories, their owners, registration paths, default behavior, and anti-goals.

## 6. CI Verification

Run or inspect the CI validation path for default composition.

Expected result: the validation fails if the default application entry point depends on an unavailable optional module and passes with default modules only.
