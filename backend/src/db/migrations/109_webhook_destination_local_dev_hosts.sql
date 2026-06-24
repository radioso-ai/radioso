ALTER TABLE workspace_webhook_destinations
  DROP CONSTRAINT IF EXISTS workspace_webhook_destinations_url_check1;

ALTER TABLE workspace_webhook_destinations
  ADD CONSTRAINT workspace_webhook_destinations_url_check1
  CHECK (
    url ~* '^https://'
    OR url ~* '^http://(([a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)(:[0-9]+)?(/|$)'
  );
