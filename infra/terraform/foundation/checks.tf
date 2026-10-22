# Project IAM bindings are additive in Terraform, so a role granted to a CI identity by hand would
# never appear in a plan. These checks read the live policies and warn on every plan of this root
# when a CI identity holds a project role this module doesn't declare, or when anyone holds a role
# on a CI identity's service account other than its one workflow's workload identity grant.

data "google_project_iam_policy" "current" {
  project = var.project_id
}

data "google_service_account_iam_policy" "ci" {
  for_each = google_service_account.ci

  service_account_id = each.value.name
}

locals {
  # A conditional grant is compared with its condition, so an unconditioned copy of a scoped
  # grant still counts as undeclared.
  declared_ci_project_grants = {
    for identity in keys(local.ci_identities) : google_service_account.ci[identity].member => toset(concat(
      [for grant in values(local.ci_project_roles) : grant.role if grant.identity == identity],
      identity == "terraform" ? [google_project_iam_custom_role.terraform_logging.name] : [],
      identity == "deploy" ? ["${google_project_iam_member.deploy_artifact_push.role} if ${google_project_iam_member.deploy_artifact_push.condition[0].expression}"] : [],
    ))
  }

  observed_project_grants = flatten([
    for binding in try(jsondecode(data.google_project_iam_policy.current.policy_data).bindings, []) : [
      for member in binding.members : {
        member = member
        grant  = "${binding.role}${try(" if ${binding.condition.expression}", "")}"
      }
    ]
  ])

  # Members that aren't CI identities fall back to their own grant, so only CI identities are judged.
  undeclared_ci_project_grants = [
    for observed in local.observed_project_grants : "${observed.member} holds ${observed.grant}"
    if !contains(lookup(local.declared_ci_project_grants, observed.member, toset([observed.grant])), observed.grant)
  ]

  undeclared_ci_account_grants = flatten([
    for identity, policy in data.google_service_account_iam_policy.ci : [
      for binding in try(jsondecode(policy.policy_data).bindings, []) : [
        for member in binding.members : "${member} holds ${binding.role} on ${google_service_account.ci[identity].email}"
        if !(binding.role == "roles/iam.workloadIdentityUser" && member == google_service_account_iam_member.ci_workload_identity_user[identity].member)
      ]
    ]
  ])
}

check "ci_identities_hold_only_declared_project_roles" {
  assert {
    condition     = length(local.undeclared_ci_project_grants) == 0
    error_message = "CI identities hold project roles this foundation does not declare. Declare them here or remove them: ${join("; ", local.undeclared_ci_project_grants)}"
  }
}

check "ci_identities_trust_only_their_workflow" {
  assert {
    condition     = length(local.undeclared_ci_account_grants) == 0
    error_message = "CI service accounts carry grants this foundation does not declare. Remove them: ${join("; ", local.undeclared_ci_account_grants)}"
  }
}
