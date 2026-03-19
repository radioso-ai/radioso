# Quickstart: Chat Connector Plugin System

**Feature**: 016-chat-connectors | **Date**: 2026-03-18

## Prerequisites

- Running Vienna backend and frontend (see root README)
- PostgreSQL database accessible
- `CONNECTOR_ENCRYPTION_KEY` added to `.env` (32-byte hex string for AES-256-GCM)

## Setup Steps

### 1. Run Migrations

Migrations run automatically on backend startup. After pulling this branch:

```bash
cd backend
npm run dev
```

This applies:
- `007_connector_config.sql` — creates `connector_configs` and `connector_migrations` tables
- WhatsApp plugin migration — creates `connector_whatsapp_contacts` and `connector_whatsapp_message_log` tables

### 2. Generate Encryption Key

Add to your `.env`:

```bash
# Generate a random 32-byte key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Add to .env
CONNECTOR_ENCRYPTION_KEY=<paste the generated key>
```

### 3. Configure WhatsApp (via UI)

1. Open the app and navigate to a workspace
2. Go to **Settings** → **Chat Connectors** tab
3. Click on the **WhatsApp** connector card
4. Fill in:
   - **Phone Number ID**: From Meta Business Suite → WhatsApp → Phone Numbers
   - **Business Account ID**: From Meta Business Suite → Settings → Business Info
   - **Access Token**: Generate a System User token in Meta Business Suite with `whatsapp_business_messaging` permission
   - **App Secret**: From Meta App Dashboard → Settings → Basic → App Secret
   - **Webhook Verify Token**: Choose any random string (you'll enter this same string in Meta's webhook config)
5. Click **Save**, then **Enable**
6. Copy the displayed **Webhook URL**

### 4. Configure Meta Webhook

1. Go to [Meta App Dashboard](https://developers.facebook.com/apps/) → your app → Webhooks
2. Click **Edit Subscription** for WhatsApp Business Account
3. Enter:
   - **Callback URL**: The webhook URL from step 3.6
   - **Verify Token**: The same string you entered in step 3.4
4. Subscribe to the **messages** field

### 5. Test

Send a text message from any WhatsApp number to your configured business phone number. You should receive an AI-generated response based on the workspace's documents.

## Configuration via API

All connector management is available via REST API:

```bash
# List connectors
curl -H "Authorization: Bearer $TOKEN" \
     -H "x-workspace-id: $WORKSPACE_ID" \
     http://localhost:3000/api/v1/connectors

# Get connector detail + config schema
curl -H "Authorization: Bearer $TOKEN" \
     -H "x-workspace-id: $WORKSPACE_ID" \
     http://localhost:3000/api/v1/connectors/whatsapp

# Save configuration
curl -X PUT \
     -H "Authorization: Bearer $TOKEN" \
     -H "x-workspace-id: $WORKSPACE_ID" \
     -H "Content-Type: application/json" \
     -d '{"config": {"phone_number_id": "...", "access_token": "...", "app_secret": "...", "webhook_verify_token": "...", "business_account_id": "..."}}' \
     http://localhost:3000/api/v1/connectors/whatsapp

# Enable
curl -X POST \
     -H "Authorization: Bearer $TOKEN" \
     -H "x-workspace-id: $WORKSPACE_ID" \
     http://localhost:3000/api/v1/connectors/whatsapp/enable

# Disable
curl -X POST \
     -H "Authorization: Bearer $TOKEN" \
     -H "x-workspace-id: $WORKSPACE_ID" \
     http://localhost:3000/api/v1/connectors/whatsapp/disable
```

## Adding a New Connector

To add a new connector (e.g. Telegram):

1. Create `backend/src/modules/connectors/plugins/telegram/`
2. Implement the `ConnectorPlugin` interface in `telegramPlugin.ts`
3. Define a `migration.sql` for any connector-specific tables
4. Register the plugin in `dependencies.ts` by adding it to the `ConnectorRegistry`

No frontend changes needed — the Settings UI renders the new connector's config form automatically from its declared schema.

## Local Development: Testing Webhooks

For local development, use a tunnel service to expose your local server:

```bash
# Using ngrok (or similar)
ngrok http 3000

# Use the generated HTTPS URL as your webhook callback in Meta's dashboard
# e.g. https://abc123.ngrok.io/api/connectors/whatsapp/<workspace_id>/webhook
```

Note: When testing locally, webhook signature verification is still enforced. Make sure your `app_secret` matches the one in Meta's App Dashboard.
