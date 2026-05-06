# Quickstart: Enterprise Feature Architecture Boundaries

## Validate Architecture Boundaries

```bash
node scripts/validate-architecture-boundaries.mjs
```

Expected result: the command reports valid architecture boundaries and exits successfully.

## Validate Enterprise Frontend Route Generation

```bash
node scripts/sync-ee-frontend-routes.mjs enable
node scripts/sync-ee-frontend-routes.mjs disable
```

Expected result: Enterprise route stubs are generated from manifests during `enable` and removed during `disable`.

## Run Focused Tests

```bash
cd backend
npm run test:unit -- application-modules default-composition

cd ../ee
npm test
```

Expected result: backend composition tests and Enterprise package tests pass.

## Build Affected Packages

```bash
cd ee
npm run build

cd ../backend
npm run build
```

Expected result: Enterprise packages and backend compile without requiring Enterprise packages in the OSS backend package manifests.
