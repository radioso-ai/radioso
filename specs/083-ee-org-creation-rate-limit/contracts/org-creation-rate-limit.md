# Contract: EE Organization Creation Rate Limit

## Existing endpoint: create additional organization

`POST /api/v1/account/accounts`

### New 429 response

Returned when the actor user has reached the effective monthly organization-creation cap.

```json
{
  "error": {
    "code": "rate_limit_exceeded",
    "message": "Organization creation limit reached. You can create up to 10 organizations per month. Try again after 2026-07-01T00:00:00.000Z.",
    "details": {
      "limit": 10,
      "used": 10,
      "periodStart": "2026-06-01",
      "resetAt": "2026-07-01T00:00:00.000Z"
    }
  }
}
```

The implementation source of truth is the backend error envelope and the code-first OpenAPI registry under `backend/src/app/http/openapi/`. `backend/openapi.yaml` and `backend/openapi.json` are generated.

## EE admin override endpoints

Base path: `/api/v1/ee/usage-limits`

Authorization: `Authorization: Bearer $EE_USAGE_ADMIN_TOKEN`

### Get override

`GET /org-creation/users/{userId}`

Response when an override exists:

```json
{
  "override": {
    "userId": "00000000-0000-0000-0000-000000000001",
    "monthlyLimit": 25,
    "unlimited": false,
    "updatedAt": "2026-06-09T00:00:00.000Z"
  }
}
```

Response when no override exists:

```json
{
  "override": null
}
```

### Put override

`PUT /org-creation/users/{userId}`

Body:

```json
{
  "monthlyLimit": 25
}
```

Body for unlimited:

```json
{
  "monthlyLimit": null
}
```

Response: same shape as `GET`, with `override` non-null.

### Delete override

`DELETE /org-creation/users/{userId}`

Response:

`204 No Content`

## Message Queue Impact

None. These endpoints do not change document worker dispatch, AMQP queue payloads, retry semantics, queue tests, or queue docs.
