---
title: "Slack Skills"
description: "How to configure Slack as a connection target and define Slack post skills through the unified skill form."
last_updated: 2026-06-23
---

# Slack Skills

Slack skills let an agent's routines post to Slack through a connected workspace
Slack installation. The installation owns OAuth credentials. The skill owns the
routine-facing allowlist and input shape.

No Slack token or secret is entered when creating a skill.

## 1. Connect Slack

Connect Slack from the agent Slack channel settings. The status response includes
the connected installation id:

- `POST /api/v1/workspaces/{workspaceId}/slack/install/start`
- `GET /api/v1/workspaces/{workspaceId}/slack/install/status`

The same Slack card can also set `escalationChannelId` on the binding. When set,
the agent posts there when a Slack question has no grounded answer.

## 2. Define an agent Slack skill

Open the agent's **Skills** list and choose **Add new skill**. Pick the
**Slack post** tile, which is enabled when the workspace has a connected Slack
installation. Choose the installation as the target and keep or edit the
suggested skill name. Required inputs are exposed to the routine by default.
Open **Advanced** to bind fixed values, include optional inputs, change
invocation behavior, narrow outcomes, or disable the skill.

The unified endpoints are:

- `GET /api/v1/agents/{agentId}/skill-capabilities`
- `GET /api/v1/agents/{agentId}/skills`
- `POST /api/v1/agents/{agentId}/skills`
- `PATCH /api/v1/agents/{agentId}/skills/{skillId}`
- `DELETE /api/v1/agents/{agentId}/skills/{skillId}`

Legacy Slack skill endpoints may remain available during cutover:

- `GET /api/v1/agents/{agentId}/slack-skills`
- `POST /api/v1/agents/{agentId}/slack-skills`
- `GET /api/v1/agents/{agentId}/slack-skills/{skillId}`
- `PATCH /api/v1/agents/{agentId}/slack-skills/{skillId}`
- `DELETE /api/v1/agents/{agentId}/slack-skills/{skillId}`

Each skill has:

- `skillName` - the routine tool-step name, such as `post_to_slack`
- `installationId` - the connected Slack installation to use
- `boundInputs` - fixed Slack inputs set by the operator
- `exposedInputs` - Slack inputs filled from routine slots
- `enabled` - whether runtime dispatch may use the skill

Supported inputs are:

- `channelId`
- `text`
- `threadTs`

In practice, bind `channelId` for a fixed destination channel or expose it when
the routine should choose the channel. Expose `text` for the routine message.

## 3. Use the skill in a routine

In a routine, add a tool step that references the skill name. At run time the
routine fills exposed inputs from collected variables, enqueues the Slack post,
and branches on the outcome.

Stable outcomes are:

- `enqueued`
- `missing_input`
- `failed`
