# Data Processing Agreement

**Last updated:** 2026-10-26

> **Draft for counsel review.** Bracketed items are decisions for counsel or the
> owner. Do not send before they are resolved.

This Data Processing Agreement ("DPA") forms part of the agreement under which
**Ljuv OÜ** (registry code 12641968, Estonia, "Radioso", the "Processor")
provides Radioso Cloud to the customer (the "Controller"). It applies to
personal data Radioso processes on the Controller's behalf, as required by
Article 28 of the GDPR.

## 1. Roles

The Controller decides why and how visitor and workspace data is processed.
Radioso processes it only to provide Radioso Cloud. For account and billing
data, Radioso is a separate controller under its
[Privacy Policy](./privacy-policy.md).

## 2. What is processed

Annex 1 sets out the subject matter, duration, nature and purpose of the
processing, and the categories of data and data subjects.

The Controller's visitors may volunteer special-category data (Article 9) in
free text, such as health, religion or beliefs. The Controller is responsible
for the Article 9(2) basis, usually explicit consent, and for telling visitors
before they write. Radioso provides the tools for this: a privacy notice before
the first message, retention windows, and erasure and export of one person's
data.

## 3. Radioso's obligations

Radioso:

1. Processes personal data only on the Controller's documented instructions.
   This DPA, the Controller's configuration of its workspace, and its use of
   the Service are those instructions. Radioso tells the Controller if it
   believes an instruction breaks the GDPR.
2. Ensures that everyone authorised to process the data is bound by
   confidentiality.
3. Applies the security measures in Annex 2.
4. Uses subprocessors only as set out in section 4.
5. Helps the Controller answer data subject requests, mainly through the
   Service's erasure, export and retention features.
6. Helps the Controller with security, breach notification, data protection
   impact assessments and prior consultation (Articles 32 to 36), taking into
   account the information available to Radioso.
7. Deletes the personal data at the end of the Service, as set out in
   section 7.
8. Gives the Controller the information needed to show compliance with
   Article 28, and allows audits as set out in section 8.

## 4. Subprocessors

The Controller gives general authorisation for the subprocessors Annex 3 lists
for the region of each of its workspaces.
Radioso gives the Controller **at least 14 days' notice by email** before it
adds or replaces a subprocessor. When a subprocessor must be replaced urgently
to keep the Service running or secure, Radioso notifies the Controller as soon
as possible, and no later than when the change takes effect. The Controller may
object on reasonable data protection grounds within 14 days of either notice.
If the parties cannot resolve the objection, the Controller may end the
affected part of the Service without penalty.

Radioso binds each subprocessor to data protection obligations that are at
least as protective as this DPA, and remains liable for their performance.

## 5. Personal data breaches

Radioso notifies the Controller **without undue delay, and no later than 48
hours** after becoming aware of a personal data breach that affects the
Controller's data. The notice describes, as far as known at the time, the
nature of the breach, the categories and approximate number of people and
records affected, the likely consequences, and the measures taken or proposed.
Radioso adds information as it becomes available.

## 6. Region and international transfers

The Controller picks the region of each workspace when it creates it:
**europe-west1 (Belgium)** or **us-central1 (Iowa, United States)**. Radioso
stores and processes the workspace's personal data in that region, using the
subprocessors Annex 3 lists for it. Radioso does not move a workspace to another
region without the Controller's written instruction.

- **europe-west1.** Hosting, language-model calls and email stay in the EU.
  Personal data leaves the EU only through Slack, and only when the Controller
  connects it.
- **us-central1.** Hosting, language-model calls and email take place in the
  United States, so the core of the Service is itself a transfer outside the EEA.

For every transfer outside the EEA, Radioso relies on the EU-U.S. Data Privacy
Framework where the subprocessor is certified, and otherwise on the European
Commission's Standard Contractual Clauses in the subprocessor's data processing
terms. [Counsel: confirm the SCC module for each transfer, and whether
us-central1 workspaces of EEA controllers need further measures.]

## 7. Deletion at the end of the Service

Within 30 days after the Service ends, Radioso deletes the Controller's
personal data unless the law requires Radioso to keep it. Before that, the
Controller can export its data through the Service. Deleted data stays in
encrypted database backups until they age out, after at most 7 days.

## 8. Audits

Radioso answers reasonable written questions about its processing and makes
the documentation in Annex 2 available. If that is not enough to show
compliance, the Controller, or an auditor bound by confidentiality, may audit
Radioso once a year with 30 days' notice, during business hours, at the
Controller's cost. Audits of Google Cloud take place through Google Cloud's
certifications and reports.

## 9. Liability and law

[Counsel: liability, governing law (Estonia) and jurisdiction, aligned with the
Terms of Service.]

---

## Annex 1: Details of the processing

| | |
|---|---|
| Subject matter | Providing Radioso Cloud: an agent that answers visitors from the Controller's documents, runs the Controller's routines, and hands off to the Controller's team. |
| Duration | For the term of the Service, then section 7. |
| Nature | Storing, indexing, retrieving, sending to a language model, displaying to the Controller's team, deleting. |
| Purpose | Answering and serving the Controller's visitors as the Controller configures. |
| Data subjects | The Controller's visitors; the Controller's team members; people named in the Controller's documents. |
| Personal data | Conversation messages; answers collected by routines (for example name, email, phone, booking details); visitor technical data (browser, language, approximate country, page URL); email addresses and message content for the email channel; documents the Controller uploads. |
| Special categories | Whatever visitors volunteer in free text, for example health, religion or beliefs. Radioso does not seek it. |
| Location | The workspace's region, as set out in section 6. |
| Retention | Set by the Controller (Settings → Workspace → Conversation retention). By default conversations are kept until deleted. |

## Annex 2: Security measures

- **Encryption at rest.** The database (including backups) and uploaded
  documents are stored on Google Cloud and encrypted with AES-256 under
  Google-managed keys. Stored credentials, such as provider API keys and
  connector secrets, are also encrypted by the application with AES-256-GCM.
- **Encryption in transit.** All traffic to and from the Service, and from
  the Service to its subprocessors, uses HTTPS. The database has no public
  address and is reachable only from Radioso's private network on Google
  Cloud. [Owner: change to "Connections to the database use TLS" once
  issue #1601 is live on both stacks.]
- **Access control.** Workspace data is visible only to that workspace's team,
  by role. Radioso's staff console has no access to workspace conversations.
- **Logs and telemetry.** Application log lines, and the copy exported to
  Radioso's log tooling, carry ids, counts and coded outcomes, never message
  content. Google Cloud Run's own request log records each request's URL, which
  can include an access token in the path and the search term of a Radioso
  staff member's account search. Logs are kept for 30 days. An error report can
  carry the error's message, which may quote personal data; error reports are
  kept in the audit log for 12 months and, where error tracking is enabled, are
  also sent to PostHog.
- **Backups.** Daily database backups, the 7 most recent kept.
- **Erasure and retention.** Deleting a conversation or a visitor removes the
  data and every copy derived from it. Retention windows erase conversations
  automatically.
- **Certifications.** Ljuv OÜ holds no ISO 27001 or SOC 2 certification of
  its own. Google Cloud, which hosts the Service, is certified to ISO/IEC
  27001, 27017 and 27018 and publishes SOC 2 reports.

## Annex 3: Subprocessors

Each workspace uses the subprocessors of its region.

### Workspaces in europe-west1

| Subprocessor | What it does | Data it receives | Where |
|---|---|---|---|
| Google Cloud (Google Cloud EMEA Ltd.) | Hosting, database, file storage | All Service data | EU (europe-west1, Belgium) |
| Microsoft Azure OpenAI (Microsoft Ireland Operations Ltd.) | Language model and embeddings | Messages, retrieved document passages and instructions sent at answer time | EU (Azure EU Data Zone; resource in Germany West Central) |
| Lettermint B.V. | Notification email to the Controller's team; the email channel, when enabled | Recipient address and email content | EU (Netherlands) |
| Slack | Notifications and handoff, only when the Controller connects Slack | Notification content the Controller configures | United States |

### Workspaces in us-central1

| Subprocessor | What it does | Data it receives | Where |
|---|---|---|---|
| Google Cloud (Google Cloud EMEA Ltd.) | Hosting, database, file storage | All Service data | United States (us-central1, Iowa) |
| OpenAI (OpenAI Ireland Ltd.) | Language model and embeddings | Messages, retrieved document passages and instructions sent at answer time | United States |
| Resend | Notification email to the Controller's team; the email channel, when enabled | Recipient address and email content | United States |
| Slack | Notifications and handoff, only when the Controller connects Slack | Notification content the Controller configures | United States |

Radioso's billing (Stripe) and product analytics (PostHog) handle data Radioso
controls itself, as its Privacy Policy describes, and are outside this DPA.
[Owner: both live stacks also send error reports to PostHog
(`error_sinks = "audit,posthog"`), and an error report can carry an error's
message quoting a workspace's personal data. Either list PostHog error tracking
as a subprocessor in both tables above, with its region, or stop sending error
reports to it.]

Providers the Controller connects with its own account and key, such as its
own OpenAI, Anthropic, Gemini or ElevenLabs account, are the Controller's own
processors, not Radioso's subprocessors. The Controller's agreement with that
provider governs them.
