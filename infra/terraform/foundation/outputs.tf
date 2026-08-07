output "github_actions_service_account_email" {
  description = "Service account GitHub Actions impersonates for routine Terraform and deployment."
  value       = google_service_account.github_actions_deployer.email
}

output "github_actions_workload_identity_provider" {
  description = "Fully qualified GitHub Actions Workload Identity Provider name."
  value       = google_iam_workload_identity_pool_provider.github_actions.name
}

output "runtime_service_account_emails" {
  description = "Application service-account emails consumed by the runtime Terraform stack."
  value       = { for name, account in google_service_account.runtime : name => account.email }
}
