# Project IAM bindings are additive in Terraform, so a role granted to a CI identity by hand would
# never appear in a plan. These checks read the live policies and warn on every plan of this root
# when a CI identity holds a project role, or can be impersonated by a principal, that this module
# does not declare.

data "google_project_iam_policy" "current" {
  project = var.project_id
}

data "google_service_account_iam_policy" "ci" {
  for_each = google_service_account.ci

  service_account_id = each.value.name
}

locals {
  declared_ci_project_roles = {
    for identity in keys(local.ci_identities) : google_service_account.ci[identity].member => toset(concat(
      [for grant in values(local.ci_project_roles) : grant.role if grant.identity == identity],
      identity == "terraform" ? [google_project_iam_custom_role.terraform_logging.name] : [],
      identity == "deploy" ? ["roles/artifactregistry.writer"] : [],
    ))
  }

  undeclared_ci_project_roles = flatten([
    for binding in jsondecode(data.google_project_iam_policy.current.policy_data).bindings : [
      for member in binding.members : "${member} holds ${binding.role}"
      if contains(keys(local.declared_ci_project_roles), member) && !contains(local.declared_ci_project_roles[member], binding.role)
    ]
  ])

  undeclared_ci_impersonators = flatten([
    for identity, policy in data.google_service_account_iam_policy.ci : [
      for binding in try(jsondecode(policy.policy_data).bindings, []) : [
        for member in binding.members : "${member} can impersonate ${google_service_account.ci[identity].email}"
        if binding.role == "roles/iam.workloadIdentityUser" && member != google_service_account_iam_member.ci_workload_identity_user[identity].member
      ]
    ]
  ])
}

check "ci_identities_hold_only_declared_project_roles" {
  assert {
    condition     = length(local.undeclared_ci_project_roles) == 0
    error_message = "CI identities hold project roles this foundation does not declare. Declare them here or remove them: ${join("; ", local.undeclared_ci_project_roles)}"
  }
}

check "ci_identities_trust_only_their_workflow" {
  assert {
    condition     = length(local.undeclared_ci_impersonators) == 0
    error_message = "CI identities can be impersonated by principals this foundation does not declare. Remove them: ${join("; ", local.undeclared_ci_impersonators)}"
  }
}
