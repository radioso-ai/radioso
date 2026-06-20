---
title: "Webhook Skills"
description: "API and contract for defining agent webhook skills that routines can call to deliver payloads to workspace destinations."
last_updated: 2026-06-17
---

# Webhook Skills

Webhook skills let an agent's routines call a configured workspace webhook
destination by name. The destination owns the URL and signing secret. The skill
owns the routine-facing allowlist and payload shape.

In practice there are three steps.

## 1. Create a webhook destination

Create the workspace destination from settings:

- `POST /api/v1/settings/webhook-destinations`

The response includes the plaintext secret once. Later reads never return it.
Webhook deliveries are signed with `X-Radioso-Signature` and include
`X-Radioso-Timestamp` and `Idempotency-Key`.

## 2. Define an agent webhook skill

Create a skill under the agent:

- `GET /api/v1/agents/{agentId}/webhook-skills`
- `POST /api/v1/agents/{agentId}/webhook-skills`
- `GET /api/v1/agents/{agentId}/webhook-skills/{skillId}`
- `PATCH /api/v1/agents/{agentId}/webhook-skills/{skillId}`
- `DELETE /api/v1/agents/{agentId}/webhook-skills/{skillId}`

Each skill has:

- `skillName` - the routine tool-step name, such as `send_lead_webhook`
- `destinationId` - the workspace webhook destination to call
- `boundPayload` - fixed payload fields set by the operator
- `exposedPayload` - payload fields filled from routine slots
- `enabled` - whether runtime dispatch may use the skill

`skillName` is unique within the agent across all agent skill types.

## 3. Use the skill in a routine

In a routine, add a tool step that references the skill name. At run time the
routine fills the exposed payload fields from collected variables, calls the
destination, and branches on the outcome.

Stable outcomes are:

- `delivered`
- `missing_input`
- `destination_not_found`
- `failed`

The payload sent to the receiver has type `agent.webhook_skill`, workspace and
agent identifiers, routine source metadata when available, and the configured
`data` object. It does not include the destination secret.
