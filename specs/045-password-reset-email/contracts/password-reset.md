# Password Reset Contract Notes

The runtime source of truth remains `backend/src/app/http/openapi/document.ts`. This file records the approved contract shapes to implement there.

## POST `/api/v1/auth/password-reset/request`

**Request**

```json
{
  "email": "user@example.com"
}
```

**Response**: `202 Accepted`

```json
{
  "accepted": true
}
```

**Behavior notes**
- Same response for known and unknown emails.
- Abuse control uses a dedicated password-reset request scope.
- Service attempts delivery only when the login user exists.

## POST `/api/v1/auth/password-reset/confirm`

**Request**

```json
{
  "token": "raw-reset-token",
  "password": "verysecurepassword"
}
```

**Response**: `200 OK`

```json
{
  "userId": "uuid",
  "accountId": "uuid",
  "organizationName": "Example Organization",
  "workspaceId": "uuid",
  "workspaceName": "Default"
}
```

**Behavior notes**
- Successful confirmation sets a fresh session cookie.
- Invalid, expired, replayed, or superseded tokens return an auth-safe error and no session cookie.
- Successful confirmation revokes all prior sessions for the user before returning.
