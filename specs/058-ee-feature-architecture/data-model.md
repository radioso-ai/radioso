# Data Model: Enterprise Feature Architecture Boundaries

## Enterprise Feature Module

Represents one Enterprise capability's contribution to runtime registration.

**Fields**
- `id`: stable unique module identifier.
- `name`: optional human-readable name.
- `register`: optional registration function for routes, migrators, hooks, policies, providers, and integrations.
- `initialize`: optional startup lifecycle hook.
- `shutdown`: optional shutdown lifecycle hook.

**Validation Rules**
- IDs must be unique within the loaded application module set.
- Feature-specific behavior must stay in the feature folder; aggregators may only compose modules.

## Feature Manifest

Represents feature ownership metadata.

**Fields**
- `id`: stable unique feature identifier.
- `name`: human-readable feature name.
- `edition`: `oss` or `enterprise`.
- `backendModuleId`: optional associated application module ID.
- `apiNamespaces`: optional list of owned API namespace paths.
- `frontendRoutes`: optional list of generated frontend route stubs.
- `docs`: optional list of documentation files owned or affected by the feature.

**Validation Rules**
- Feature IDs must be unique.
- Frontend route paths must be unique.
- Referenced documentation files must exist.
- Enterprise-only routes must not be generated in OSS mode.

## Frontend Route Contribution

Represents one generated Next route stub.

**Fields**
- `relativePath`: generated file path under `frontend/`.
- `packageName`: npm package that owns the implementation.
- `exportPath`: package export path.
- `exports`: named exports or default export to re-export.
- `runtime`: optional Next runtime declaration.
- `dynamic`: optional Next dynamic/static declaration.

**Validation Rules**
- Generated paths must stay under `frontend/app`.
- Package names must be Enterprise package names for Enterprise manifests.
- Duplicate generated paths are invalid.
- Content is generated and marked as generated.

## Import Boundary Rule

Represents an automated dependency constraint.

**Fields**
- `id`: stable rule identifier.
- `description`: human-readable explanation.
- `sourcePattern`: path pattern for importing files.
- `forbiddenImportPattern`: import specifier or resolved path pattern that is not allowed.
- `allowedImportPattern`: optional allowlist for public contracts.
- `exceptions`: temporary documented exceptions.

**Validation Rules**
- OSS source paths must not import `ee/` or `@radioso/enterprise-*`.
- Backend cross-module imports should use `contracts/` surfaces where a representative public contract exists.
- Exceptions must be explicit and reviewable.

## Public Module Contract

Represents an approved cross-module import surface.

**Fields**
- `path`: contract folder or barrel file.
- `owner`: owning backend module or app composition layer.
- `exports`: types or values intentionally supported for external consumers.

**Validation Rules**
- Contract files must not contain product-specific Enterprise behavior.
- Contract exports should be narrow and documented by file location and tests.
