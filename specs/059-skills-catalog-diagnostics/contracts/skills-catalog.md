# Contract: Skills Catalog

The runtime source of truth remains `backend/src/app/http/openapi/document.ts`. This file records the approved contract shape to implement there.

## List Skills

```http
GET /api/v1/skills
```

Purpose: Return read-only skill catalog metadata for the current workspace context.

Security: workspace session or bearer workspace token, consistent with other authenticated workspace APIs.

Response `200`:

```json
{
  "skills": [
    {
      "name": "retrieval.answer",
      "displayName": "Retrieval answer",
      "description": "Generate a grounded answer from workspace evidence without assistant persona.",
      "owner": "retrieval",
      "executionClass": "interactive",
      "availability": {
        "state": "available"
      },
      "supportedCallers": ["retrieval_api", "sdk", "mcp"],
      "requiredCapabilities": ["retrieval.answer"],
      "contractReferences": [
        {
          "kind": "http",
          "label": "Retrieval answer API",
          "method": "POST",
          "path": "/api/v1/retrieval/answer"
        }
      ],
      "diagnostics": {
        "defined": true,
        "strategyAware": true
      }
    }
  ]
}
```

## Get Skill Detail

```http
GET /api/v1/skills/{skillName}
```

Purpose: Return one skill catalog entry by stable skill name.

Response `200`: one `SkillCatalogEntry`.

Response `404`:

```json
{
  "error": {
    "code": "skill_not_found",
    "message": "Skill not found"
  }
}
```

## Shared Shapes

### SkillCatalogEntry

- `name`: stable string identifier
- `displayName`: string
- `description`: string
- `owner`: `assistant`, `retrieval`, `documents`, `mcp`, `platform`, or `auth`
- `executionClass`: `interactive`, `deferred`, or `administrative`
- `availability`: `SkillAvailability`
- `supportedCallers`: array of caller surface values
- `requiredCapabilities`: array of shared capability names
- `contractReferences`: array of `SkillContractReference`
- `diagnostics`: `SkillDiagnosticsSummary`

### SkillAvailability

- `state`: `available`, `forbidden`, or `unavailable`
- `reason`: optional stable reason code

### SkillContractReference

- `kind`: `http`, `sdk`, `mcp_tool`, or `documentation`
- `label`: string
- `method`: optional HTTP method
- `path`: string

### SkillDiagnosticsSummary

- `defined`: boolean
- `strategyAware`: boolean
- `supportedFields`: optional array of diagnostic field names

## OpenAPI Ownership

The implementation must add these operations and schemas to `backend/src/app/http/openapi/document.ts`, then regenerate:

- `backend/openapi.yaml`
- `backend/openapi.json`

Generated SDK types must be refreshed from the generated OpenAPI output.
