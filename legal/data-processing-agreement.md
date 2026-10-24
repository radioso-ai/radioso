# Data Processing Agreement (Radioso Cloud)

**Version:** [1.0] · **Last updated:** 2026-10-24

> **Fill in before publishing.** This is a drafting aid, not legal advice. Replace
> every `[...]` placeholder and have counsel review the whole agreement, in
> particular the transfer mechanism (Section 12), liability (Section 15) and
> governing law (Section 18), before it is offered to any customer.
>
> **Before sending:** Annex 2 states that traffic between the application and its
> PostgreSQL database is encrypted with TLS. Confirm that TLS to the database is
> enabled on the stack the customer uses before sending this agreement.

This Data Processing Agreement ("**DPA**") is entered into between:

- **[Customer legal name]**, [legal form], registered in [country] under registry
  code [number], with its registered address at [address] (the "**Customer**");
  and
- **Ljuv OÜ**, a private limited company registered in Estonia under registry
  code 12641968, with its registered address at Ümera tn 25-39, Lasnamäe
  linnaosa, 13816 Tallinn, Estonia ("**Radioso**"),

each a "**party**". It forms part of the agreement under which Radioso provides
Radioso Cloud to the Customer, consisting of the [Terms of Service](./terms-of-service.md)
and any order or written commercial agreement between the parties (the
"**Agreement**").

---

## 1. Definitions

- **GDPR** means Regulation (EU) 2016/679. "Controller", "processor", "data
  subject", "personal data", "processing", "personal data breach" and
  "supervisory authority" have the meanings given in the GDPR.
- **Data Protection Law** means the GDPR and any EU or Member State law that
  applies to the processing under this DPA[, and, where they apply, the UK GDPR
  and the Swiss Federal Act on Data Protection].
- **Customer Personal Data** means personal data that Radioso processes on behalf
  of the Customer in providing Radioso Cloud, as described in Annex 1.
- **Service** means Radioso Cloud, the hosted Radioso service operated by Radioso.
- **Stack** means one of the two separate deployments of the Service: `live-eu`,
  hosted in Google Cloud region `europe-west1` (Belgium) and reached at
  `app.radioso.ai`, and `live`, hosted in Google Cloud region `us-central1`
  (Iowa, United States) and reached at `app-us.radioso.ai`. Each workspace is
  held on exactly one Stack.
- **Subprocessor** means a third party engaged by Radioso that processes Customer
  Personal Data on Radioso's behalf.
- **Customer-Connected Service** means a third-party service that the Customer
  connects to the Service using its own account or credentials, such as its own
  model provider key, its own ElevenLabs account, its own Slack workspace, its
  own WhatsApp Business account, or a webhook or external MCP server it
  configures.
- **SCCs** means the standard contractual clauses annexed to Commission
  Implementing Decision (EU) 2021/914.
- **Special Categories of Data** means the categories of personal data listed in
  Article 9(1) GDPR.

## 2. Scope and roles

2.1 The Customer is the controller of Customer Personal Data, and Radioso is its
processor. Where the Customer itself acts as a processor for a third-party
controller, the Customer warrants that its instructions, including the
appointment of Radioso as a sub-processor, are authorised by that controller,
and Radioso is the Customer's sub-processor.

2.2 Radioso processes data about the Customer's own Radioso account (sign-in
accounts of the Customer's team members, organization administration, billing
and payment) as an independent controller under its
[Privacy Policy](./privacy-policy.md). This DPA does not cover that processing.

2.3 This DPA does not apply to Radioso Self-Hosted. When the Customer runs the
software on its own infrastructure, Radioso does not process the data it
handles.

2.4 Annex 1 sets out the subject matter, duration, nature and purpose of the
processing, the types of personal data and the categories of data subjects, as
Article 28(3) GDPR requires.

## 3. Instructions (Article 28(3)(a))

3.1 Radioso processes Customer Personal Data only on the Customer's documented
instructions, including with regard to transfers to a third country, unless EU
or Member State law to which Radioso is subject requires otherwise. In that
case Radioso informs the Customer of that legal requirement before processing,
unless that law prohibits it on important grounds of public interest.

3.2 The Customer's documented instructions are this DPA, the Agreement, and the
Customer's use and configuration of the Service: the agents, routines, skills,
documents, channels, retention windows, privacy notices, connected services and
settings it creates, and the requests it makes through the dashboard, the API,
the SDK and the MCP server. Additional instructions require written agreement.

3.3 Radioso informs the Customer without delay if, in its opinion, an
instruction infringes Data Protection Law.

3.4 Radioso does not use Customer Personal Data to train general-purpose
models, does not sell it, and does not process it for its own purposes.
[Counsel: confirm whether aggregated usage counts used for billing and plan
limits need express mention here.]

## 4. Confidentiality (Article 28(3)(b))

4.1 Radioso ensures that every person it authorises to process Customer Personal
Data has committed to confidentiality or is under an appropriate statutory
obligation of confidentiality.

4.2 Radioso limits access to Customer Personal Data to the personnel who need it
to operate, secure and support the Service. [Owner: name the roles that hold
production access and how that access is granted, reviewed and revoked.]

## 5. Security (Article 28(3)(c) and Article 32)

5.1 Radioso implements the technical and organisational measures described in
Annex 2. Radioso may change those measures over time, provided the change does
not reduce the overall level of protection of Customer Personal Data.

5.2 The Customer is responsible for the security of its own use of the Service,
including who it invites and with which role, how it stores credentials and
tokens, which channels and Customer-Connected Services it enables, the
retention windows it sets, and the privacy notice it shows its visitors.

## 6. Subprocessors (Article 28(2), (3)(d) and (4))

6.1 **General written authorisation.** The Customer gives Radioso general
written authorisation to engage Subprocessors. The Subprocessors engaged on the
date of this DPA are listed in Annex 3 and, for each Stack, at
<https://docs.radioso.ai/operators/subprocessors> (the "**Subprocessor Page**").

6.2 **Prior notice.** Radioso notifies the Customer of any intended addition or
replacement of a Subprocessor on the Customer's Stack by email to the owners of
the Customer's organization at least **30 days** before the new Subprocessor
processes Customer Personal Data, and updates the Subprocessor Page at the same
time. The notice names the Subprocessor, what it will do, what Customer Personal
Data it will receive and where it will process it. [Counsel: decide whether to
allow a shorter notice period for an emergency replacement needed to keep the
Service secure or available, and on what conditions.]

6.3 **Right to object.** The Customer may object to the change in writing to
hello@radioso.ai within the 30-day notice period, on reasonable grounds relating
to the protection of Customer Personal Data. The parties will then discuss the
objection in good faith. Radioso may propose an alternative, such as a
configuration of the Customer's workspace under which the new Subprocessor does
not process its data, or a Customer-Connected Service that replaces it. If the
parties do not resolve the objection before the change takes effect, the
Customer may terminate the affected part of the Service by written notice with
effect before the change, and Radioso refunds any prepaid fees for the period
after termination. [Counsel: confirm the termination and refund remedy and
whether it should be the Customer's sole remedy.]

6.4 **Flow-down.** Radioso engages each Subprocessor under a written contract
that imposes data protection obligations providing at least the level of
protection of this DPA, in particular sufficient guarantees to implement
appropriate technical and organisational measures. Radioso remains fully liable
to the Customer for the performance of each Subprocessor's obligations.

6.5 **Customer-Connected Services.** A Customer-Connected Service is not a
Subprocessor. Radioso transmits Customer Personal Data to it on the Customer's
instruction, and the Customer's own agreement with its provider governs that
provider's processing.

## 7. Data subject requests (Article 28(3)(e))

7.1 Taking into account the nature of the processing, Radioso assists the
Customer by appropriate technical and organisational measures, insofar as this
is possible, in responding to requests from data subjects exercising their
rights under Chapter III GDPR. The Service provides these measures to the
Customer directly:

- **Access and portability:** a data subject lookup across website visitors,
  email addresses and Slack members, and an export of what the Service holds
  about the identities the Customer confirms, as one JSON document
  ([Answering a data subject request](https://docs.radioso.ai/operators/data-subject-requests)).
- **Erasure:** deletion of one conversation, of a website visitor with every
  conversation they had, and of a data subject's confirmed identities across
  channels, each removing the content derived from it
  ([Deleting conversation data](https://docs.radioso.ai/operators/deleting-conversation-data)).
- **Storage limitation:** a workspace retention window that erases each
  conversation after a chosen number of days without activity, and fixed
  windows for derived copies
  ([Data retention](https://docs.radioso.ai/operators/data-retention)).
- **Information:** a privacy notice the website widget shows before a visitor's
  first message, with the notice version recorded on the conversation.

7.2 If Radioso receives a request directly from a data subject concerning
Customer Personal Data, it forwards the request to the Customer without undue
delay and does not respond to it, other than to tell the data subject to contact
the Customer, unless the Customer authorises it to.

7.3 Where the Customer cannot fulfil a request with these features, Radioso
provides reasonable further assistance on written request. [Counsel: decide
whether assistance beyond the self-serve features is chargeable.]

## 8. Assistance with security, breach notification, impact assessments and prior consultation (Article 28(3)(f))

8.1 Taking into account the nature of the processing and the information
available to it, Radioso assists the Customer in ensuring compliance with its
obligations under Articles 32 to 36 GDPR.

8.2 For a data protection impact assessment under Article 35 GDPR, and any prior
consultation of a supervisory authority under Article 36 GDPR, Radioso provides
on request the information about the Service that the Customer reasonably needs
and does not otherwise have: this DPA and its annexes, the Subprocessor Page, the
documentation on data residency, visitor data, retention and deletion, and
written answers to reasonable questions about the processing.

## 9. Personal data breaches (Article 33(2))

9.1 Radioso notifies the Customer of a personal data breach affecting Customer
Personal Data **without undue delay and in any event no later than 48 hours**
after becoming aware of it. Radioso sends the notification by email to the
owners of the Customer's organization [and to any security contact the Customer
designates in writing].

9.2 The notification describes, to the extent the information is available at
the time:

- (a) the nature of the breach, including where possible the categories and
  approximate number of data subjects concerned and the categories and
  approximate number of personal data records concerned;
- (b) the name and contact details of Radioso's contact point for the breach;
- (c) the likely consequences of the breach; and
- (d) the measures Radioso has taken or proposes to take to address the breach,
  including measures to mitigate its possible adverse effects.

Where Radioso cannot provide all of this information at once, it provides it in
phases as it becomes available, without undue further delay.

9.3 Radioso takes reasonable steps to contain and investigate the breach and to
mitigate its effects, and cooperates with the Customer in its own assessment and
in any notification it makes to a supervisory authority or to data subjects.
Unless the law requires it, Radioso does not notify the Customer's supervisory
authority or data subjects on the Customer's behalf without the Customer's
agreement.

9.4 A notification under this Section is not an acknowledgement of fault or
liability by Radioso.

## 10. Deletion and return at the end of the Service (Article 28(3)(g))

10.1 **During the term**, the Customer can retrieve Customer Personal Data
through the Service, including the conversation history API and the data
subject export, and can delete it as described in Section 7. [Owner: the Service
has no single whole-workspace export. Decide whether to offer one on request at
the end of the Service, and reconcile with the 30-day export statement in
Section 10 of the Terms of Service.]

10.2 **At the end of the Service**, the Customer deletes its organization
(**Settings → Workspace → Delete organization**, available to owners). Deleting
the organization deletes every workspace in it from the database, with every
conversation, visitor record, document, chunk and embedding, in the same way
the Service deletes a single conversation or visitor. If the Customer has not
deleted its organization within [30] days after the end of the Agreement,
Radioso deletes it. [Owner: confirm the period and the internal procedure for
deleting an organization the Customer left in place.] [Owner: deleting a single
document removes its uploaded file from document storage, but deleting a
workspace or an organization leaves the uploaded files in the document bucket.
Add that cleanup, or commit here to removing the files within a stated period,
before sending this DPA.]

10.3 **Backups and logs.** Deletion reaches the live database immediately.
Copies remain in the Service's backups and logs until they
age out, and Radioso does not restore or use them in the meantime except to
recover the Service after an incident:

| Where | Kept for |
|---|---|
| Database backups | the 7 most recent daily backups |
| Point-in-time recovery logs, where enabled on the Stack | 7 days |
| Application and request logs | 30 days |

10.4 **What deletion cannot recall.** Deletion does not reach data that has
already left the Service on the Customer's instruction: notices already emailed
or posted to Slack, webhook payloads already delivered, emails already sent,
and data held by a Customer-Connected Service under the Customer's own
agreement with its provider.

10.5 Radioso may retain Customer Personal Data after the end of the Service only
where EU or Member State law requires it to store the data, and then only for
that purpose.

## 11. Audits and information (Article 28(3)(h))

11.1 Radioso makes available to the Customer the information necessary to
demonstrate compliance with Article 28 GDPR and this DPA. Radioso first provides
documentation: this DPA and its annexes, the Subprocessor Page, the product
documentation referred to in this DPA, and written answers to a reasonable
security questionnaire [no more than once in any 12-month period].

11.2 Radioso does not hold its own ISO/IEC 27001 certification or SOC 2 report.
The Service is hosted on Google Cloud, which holds ISO/IEC 27001, ISO/IEC 27017
and ISO/IEC 27018 certifications and SOC 2 reports for the services the Service
uses. The Customer can review them through Google Cloud's compliance resources
at <https://cloud.google.com/security/compliance>, under Google's terms for
access to them.

11.3 Where the documentation does not reasonably demonstrate compliance, where
a supervisory authority requires it, or following a personal data breach
affecting Customer Personal Data, the Customer, or an independent auditor it
mandates who is bound by confidentiality and is not a competitor of Radioso,
may conduct an audit, including an inspection. The Customer gives at least [30]
days' written notice, the audit takes place during business hours, avoids
disrupting the Service, and does not extend to other customers' data or to
Subprocessors' facilities, which are covered by the Subprocessors' own audit
terms. [Counsel: frequency, cost allocation, and whether Radioso may charge for
time spent beyond a set allowance.]

## 12. International transfers (Chapter V GDPR)

12.1 Radioso is established in the European Union (Estonia).

12.2 **Hosting location.** On the `live-eu` Stack, the Service stores Customer
Personal Data in Google Cloud region `europe-west1` (Belgium). On the `live`
Stack, it stores Customer Personal Data in Google Cloud region `us-central1`
(Iowa, United States). The Customer's choice of Stack is an instruction under
Section 3, including, for the `live` Stack, the instruction to transfer Customer
Personal Data to the United States. [Owner: confirm whether Cloud SQL backups,
Secret Manager on the `live` Stack, and Cloud Logging, which holds both Stacks'
logs in its `global` location, keep data in the Stack's region, and state the
result in Annex 2.]

12.3 **Subprocessors outside the EEA.** Some Subprocessors in Annex 3 process
Customer Personal Data in the United States on both Stacks. For each such
transfer, Radioso relies on the Subprocessor's certification under the EU-U.S.
Data Privacy Framework where it holds one, and otherwise on SCCs incorporated in
Radioso's agreement with that Subprocessor, together with supplementary measures
where needed. [Counsel: confirm, for each Subprocessor in Annex 3, the mechanism
it offers (Data Privacy Framework certification, SCCs, or both). For onward
transfers from Radioso as processor to a Subprocessor, the applicable SCCs are
Module Three (processor to processor). If the Customer is established outside
the EEA, consider whether Module Four (processor to controller) is needed
between Radioso and the Customer. Add the UK International Data Transfer
Addendum and Swiss amendments if the Customer or its data subjects are in the
UK or Switzerland.]

12.4 Customer-Connected Services process data where their provider and the
Customer's configuration place it. The Customer is responsible for the transfer
mechanism with its own provider.

## 13. Special Categories of Data

13.1 Visitors may volunteer Special Categories of Data in free text, such as
information about their health, religious or philosophical beliefs, or sex life
or sexual orientation, and documents the Customer provides may contain them.
The Service processes such data as part of conversation and document content.
It does not detect or classify Special Categories of Data on its own.

13.2 The Customer is responsible for having a condition under Article 9(2) GDPR
for processing Special Categories of Data, such as the data subject's explicit
consent, and for the notice it gives its visitors. Radioso processes Special
Categories of Data under the same measures as other Customer Personal Data
(Annex 2). The Customer can limit how long they are kept with a retention
window, and can delete them as described in Section 7.

## 14. Term

This DPA takes effect on the date the Customer accepts it and continues for as
long as Radioso processes Customer Personal Data, including after the Agreement
ends until the deletion described in Section 10 is complete.

## 15. Liability

[Counsel: liability under this DPA. For example: each party's liability arising
out of or in connection with this DPA is subject to the limitations and
exclusions of liability in the Agreement, except where Data Protection Law does
not permit limiting it.]

## 16. Order of precedence

If this DPA conflicts with the Agreement regarding the processing of Customer
Personal Data, this DPA prevails. If SCCs apply under Section 12 and conflict
with this DPA, the SCCs prevail.

## 17. Changes to this DPA

[Counsel: how changes are made. For example: Radioso may update this DPA to
reflect a change in Data Protection Law or in the Service, provided the update
does not reduce the protection of Customer Personal Data, and gives the
Customer at least 30 days' notice by email of any material change.]

## 18. Governing law and jurisdiction

[Counsel: governing law and jurisdiction. The Terms of Service choose the laws
of Estonia and the courts of Tallinn, Estonia.]

---

**Signed for and on behalf of the Customer**

Name: [ ] · Title: [ ] · Date: [ ] · Signature: [ ]

**Signed for and on behalf of Ljuv OÜ**

Name: [ ] · Title: [ ] · Date: [ ] · Signature: [ ]

---

## Annex 1: Details of the processing

**Subject matter.** Providing Radioso Cloud to the Customer: conversational
agents that answer from the Customer's own documents, act through skills and
routines, and hand conversations to the Customer's team.

**Duration.** The term of the Agreement, and afterwards until deletion under
Section 10.

**Nature of the processing.** Storage, organisation and structuring (parsing,
chunking, embedding and indexing documents); retrieval; transmission to model
providers to generate replies, summaries and embeddings; routing conversations
to the Customer's team members; sending notices and emails the Customer
configures; export; deletion.

**Purpose.** Providing, securing and supporting the Service under the Agreement
and the Customer's instructions.

**Categories of data subjects.**

- Visitors and end users who talk to the Customer's agents through the website
  widget, the public chat link, the REST API, the SDK, the MCP server, Slack,
  WhatsApp or voice.
- The Customer's team members, as they appear in workspace data: replies they
  write in a conversation, takeovers, assignments, approvals, activity, and
  their conversations with Ray, the Service's operator assistant.
- People mentioned in documents the Customer uploads or connects.
- Recipients of contact requests, notices and emails the Customer configures.

**Categories of personal data.**

- Conversation content: everything a visitor writes, and the agent's and team's
  replies.
- Identity and contact details a visitor gives, or that the Customer's site
  passes as a signed, verified customer id.
- Values routines collect, such as dates, phone numbers and booking details.
- Request facts recorded when a conversation starts: IP address, country, region
  and city, browser user agent and language, entry page and referrer.
- A visitor key the website widget keeps in the visitor's browser storage, which
  links one browser's conversations.
- Channel identifiers: email address, Slack member id, WhatsApp phone number.
- Transcripts of voice calls. Call audio and recordings stay in the Customer's
  own ElevenLabs account.
- Ratings and comments visitors leave on answers.
- Personal data contained in the Customer's documents.
- Team members' names and email addresses as they appear on their actions.

**Special Categories of Data.** Visitors may volunteer them in free text, a
routine the Customer authors may collect them, and the Customer's documents may
contain them (Section 13).

**Frequency.** Continuous, for as long as the Customer uses the Service.

**Retention.** As the Customer sets and deletes it (Section 7), subject to the
fixed windows documented at
<https://docs.radioso.ai/operators/data-retention>, and to the backup and log
windows in Section 10.3.

## Annex 2: Technical and organisational measures (Article 32)

Each measure below describes the Service as it runs on Radioso Cloud.

**Hosting and separation**

- The Service runs on Google Cloud: Cloud Run for the application and workers,
  Cloud SQL for PostgreSQL 16 as the system of record, Cloud Storage for
  uploaded documents, Cloud Tasks for queued work, and Secret Manager for
  secrets.
- Each Stack has its own database instance, document bucket, task queues and
  secrets. The `live-eu` Stack's secrets are replicated only in `europe-west1`.
- Request and application logs from both Stacks are held in Cloud Logging's
  `global` location for 30 days. [Owner: see Section 12.2.]

**Encryption at rest**

- Google Cloud encrypts the Cloud SQL database, its backups and the document
  bucket at rest with Google-managed AES-256 keys. The Service does not use
  customer-managed encryption keys.
- The Service additionally encrypts credentials the Customer stores (model
  provider API keys, voice runtime keys, connector and OAuth tokens, webhook
  signing secrets, and external MCP connection credentials) with AES-256-GCM,
  under an application key held in Secret Manager.
- Passwords are stored as bcrypt hashes. Session, email verification and
  password reset tokens are stored as SHA-256 hashes.

**Encryption in transit**

- Browsers, website embeds, API, SDK and MCP clients reach the Service over
  HTTPS only, terminated by Google's HTTPS load balancer or Cloud Run.
- The Service calls model providers and every other outside service over HTTPS.
- Traffic between the application and its PostgreSQL database is encrypted with
  TLS.
- The database has a private IP address only and no public IP address. It is
  reachable only from the Stack's own virtual network.

**Access control within the Customer's organization**

- Every workspace's data is scoped to that workspace. Team members hold the
  owner, admin or member role, and API credentials, personal or service-account,
  carry a role too.
- Deleting conversations and visitors, setting a retention window, and every
  step of a data subject request require the `workspace.history.delete`
  permission, which owners and admins hold.
- Deletions, retention sweeps and data subject requests each record an audit
  event that names who acted and how many records were affected. The event
  carries none of the content, and none of the email addresses, Slack member ids
  or lookup queries a data subject request named.

**Access by Radioso personnel**

- Radioso's staff console shows organizations, their owners, usage and plan, and
  staff accounts. It has no route to conversations, documents or other workspace
  content. Each staff read is logged with the staff member and the action.
- Access to production infrastructure is controlled through Google Cloud
  identity and access management. The automated deploy identities are scoped
  to what each workflow needs.
- [Owner: name who holds production and database access, how access is
  approved, reviewed and logged, and how personnel are bound to
  confidentiality.]

**Data minimisation towards model providers**

- A visitor's IP address and raw user agent never reach a model, a prompt or a
  stored trace. Of the request facts, only country, region, city, language,
  referrer and entry page are available to a prompt.
- A model provider receives what a turn needs: the visitor's message, the
  conversation so far, the document passages retrieved for it and the agent's
  instructions.

**Logging and telemetry**

- Cloud Run's request logs record each request's path, status, client IP
  address and user agent. The application's own request log lines redact
  cookies, authorization headers, session headers, client-address headers and
  the signed visitor request facts.
- Error reports and log records exported to PostHog have fields named for
  message bodies, content, prompts, credentials and tokens redacted. Log
  records exported to PostHog carry only flat attribute fields, each text value
  cut at 256 characters.
- [Owner: the application log line written for each audit event (`audit_event`)
  includes the event's full metadata and the retrieval query the Service
  derives from a visitor's message (`parsedSemanticQuery`,
  `parsedLexicalQuery`). Those lines reach Cloud Logging. Remove that content
  from the log line, or describe it here, before stating that logs are free of
  conversation content.]

**Retention, deletion and backups**

- The Customer can delete a conversation, a visitor, a data subject's
  identities, a workspace or the whole organization, and can set a workspace
  retention window that erases idle conversations every 15 minutes.
- Fixed windows apply to derived copies regardless of the Customer's settings,
  for example 30 days for a conversation summary and 30 days for the raw copy of
  an inbound email.
- Cloud SQL takes a backup every day and keeps the 7 most recent. Production
  databases have deletion protection enabled.
- [Owner: the database runs in a single zone (`ZONAL` availability). State the
  recovery objectives you commit to, if any.]

**Testing and incident response**

- [Owner: describe how security measures are tested and reviewed (Article
  32(1)(d)).]
- [Owner: describe how incidents are detected and handled, and who is
  responsible for the 48-hour notification in Section 9. Cloud Monitoring alert
  policies are defined in the infrastructure code; state whether they are
  enabled on each Stack.]

**Certifications**

- Ljuv OÜ holds no security certification of its own.
- Google Cloud, the hosting provider, holds ISO/IEC 27001, ISO/IEC 27017 and
  ISO/IEC 27018 certifications and SOC 2 reports.

## Annex 3: Subprocessors

The current list for each Stack, with what each Subprocessor receives and where
it processes it, is maintained at
<https://docs.radioso.ai/operators/subprocessors>. On the date of this DPA it is:

| Subprocessor | Purpose | `live-eu` location | `live` location |
|---|---|---|---|
| Google Cloud ([Google Cloud EMEA Limited, Ireland — confirm contracting entity]) | Hosting, database, document storage, queues, secrets, logs | `europe-west1`, Belgium; logs in Cloud Logging's `global` location | `us-central1`, Iowa, United States; logs in Cloud Logging's `global` location |
| OpenAI ([confirm contracting entity]) | Models for answers, Ray, query rewriting, reranking, summaries, document embeddings and metadata extraction, for workspaces using Radioso's models | OpenAI's global API | OpenAI's global API |
| Resend ([confirm contracting entity]) | Sending account mail, contact requests and routine notices | United States | United States |
| PostHog Inc. | Error reports and application logs | EU (`eu.i.posthog.com`) | EU (`eu.i.posthog.com`) |

Customer-Connected Services (Section 6.5) are not Subprocessors. Stripe and
Google Sign-In process data about the Customer's Radioso account, which Radioso
controls under its Privacy Policy (Section 2.2), and do not receive Customer
Personal Data.
