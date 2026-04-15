ALTER TABLE workspaces
ADD COLUMN IF NOT EXISTS website_embed_enabled BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN IF NOT EXISTS website_embed_token TEXT,
ADD COLUMN IF NOT EXISTS website_embed_allowed_origins TEXT[] NOT NULL DEFAULT '{}',
ADD COLUMN IF NOT EXISTS website_embed_launcher_label TEXT NOT NULL DEFAULT 'Chat with us',
ADD COLUMN IF NOT EXISTS website_embed_launcher_icon TEXT NOT NULL DEFAULT 'chat',
ADD COLUMN IF NOT EXISTS website_embed_launcher_position TEXT NOT NULL DEFAULT 'bottom-right';

