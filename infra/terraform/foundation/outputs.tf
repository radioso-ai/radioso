output "ci_service_account_emails" {
  description = "Service account each GitHub workflow impersonates, keyed terraform, deploy, and docs where enabled. Set the GitHub environment variables from these."
  value       = { for name, account in google_service_account.ci : name => account.email }
}

output "github_actions_workload_identity_provider" {
  description = "Fully qualified GitHub Actions Workload Identity Provider name."
  value       = google_iam_workload_identity_pool_provider.github_actions.name
}

output "runtime_service_account_emails" {
  description = "Application service-account emails consumed by the runtime Terraform stack."
  value       = { for name, account in google_service_account.runtime : name => account.email }
}
