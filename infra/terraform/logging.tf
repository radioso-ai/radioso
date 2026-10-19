# The project's `_Default` log bucket receives every Cloud Run request and application log line, so
# its retention is how long a log entry about a conversation survives the conversation itself. The
# bucket exists in every project and cannot be created or deleted: applying this adopts it and sets
# the retention, and destroying it only drops it from state. One stack per project owns it, the
# same one that owns the project's API enablement, so a second regional stack in that project
# leaves it alone while its logs land in the same bucket.
resource "google_logging_project_bucket_config" "default" {
  count = var.manage_project_services ? 1 : 0

  project        = var.project_id
  location       = "global"
  bucket_id      = "_Default"
  retention_days = 30

  depends_on = [google_project_service.apis]
}
