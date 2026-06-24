# Privacy Policy

**Last updated:** 2026-06-24

> **Fill in before publishing.** Replace every `[...]` placeholder. This document
> is a drafting aid, not legal advice. Have counsel review it against your actual
> data flows, sub-processors, and the jurisdictions you operate in before you rely
> on it.

This Privacy Policy explains how **Ljuv OÜ** ("Radioso", "we", "us")
collects, uses, and protects personal data in connection with the Radioso context
platform for grounded assistants (the "Service"). Ljuv OÜ is a private limited
company registered in Estonia under registry code 12641968.

Radioso is offered in two ways, and which parts of this policy apply depends on
how you use it:

- **Radioso Cloud** — the hosted service we operate at `radioso.ai` and related
  subdomains, plus the `radioso.ai` website. For Radioso Cloud, we are the
  **data controller** for account and website data, and a **data processor** for
  the content you ingest and the conversations your end users have.
- **Radioso Self-Hosted** — the software you deploy and operate on your own
  infrastructure. For self-hosted deployments, **the operator who runs the
  deployment is the data controller**, and we are not a party to that processing.
  We receive personal data from a self-hosted deployment only if you choose to
  contact us, send diagnostics, or use an optional connected service.

Where a section applies only to one of these, it says so.

---

## 1. Who we are and how to contact us

**Data controller (Radioso Cloud and website):**

- Entity: **Ljuv OÜ** (Estonian private limited company, registry code 12641968)
- Registered address: **Ümera tn 25-39, Lasnamäe linnaosa, 13816 Tallinn, Harju maakond, Estonia**
- Privacy contact: **hello@radioso.ai**
- EU representative: **Not applicable — Ljuv OÜ is established in the EU (Estonia)**
- Data Protection Officer: **Not appointed**

If you run **Radioso Self-Hosted**, the controller is the organization operating
that deployment. Direct privacy requests about a self-hosted instance to that
operator, not to us.

---

## 2. The data we process

We group data by source rather than by feature, because the same categories show
up across the product.

### 2.1 Account and billing data (Radioso Cloud)

- Name, email address, and authentication identifiers (including identifiers from
  Google sign-in if you use it).
- Workspace and organization names and membership.
- Billing and subscription details. Payment card data is handled by our payment
  processor; we do not store full card numbers.

### 2.2 Website data (radioso.ai)

- Pages visited, referrer, approximate location derived from IP address, device
  and browser type.
- Information you submit through forms (for example, a contact or sign-up form).

### 2.3 Ingested content and retrieval data

- Documents, files, and connected sources you upload or link for ingestion.
- The text chunks, embeddings (vectors), and metadata derived from that content
  during processing.

For **Radioso Cloud**, we process this content **on your behalf as a processor**,
under your instructions, to provide retrieval and grounded answers. We do not use
your ingested content to train general-purpose models.

### 2.4 Assistant and conversation data

- Messages exchanged with an assistant, including end-user messages on an
  embedded website widget, the REST API, the SDK, and the MCP server.
- Conversation history, channel routing metadata, and any human-in-the-loop
  operator actions (for example, a human agent taking over a conversation).

End users who chat with an assistant you operate may submit personal data in their
messages. Where you control the assistant, **you decide** what is collected and
are responsible for giving those end users appropriate notice.

### 2.5 Operational and security data

- Logs, audit events, error reports, and basic usage metrics needed to run,
  secure, and debug the Service.
- These are designed to **exclude** raw prompts, completions, document content,
  retrieved chunks, tokens, credentials, cookies, and connection strings.

### 2.6 Support and diagnostics (self-hosted)

If you contact support or send us diagnostics from a self-hosted deployment, we
process whatever you choose to share with us for that purpose.

---

## 3. AI providers and how content reaches them

To produce grounded answers, the Service sends prompts and retrieved context to
the AI provider configured for your workspace or deployment. Radioso Cloud uses
more than one provider (for example, OpenAI and Anthropic), depending on
configuration.

- For **Radioso Cloud**, the active providers are listed in the sub-processor
  table in Section 6.1.
- For **Radioso Self-Hosted**, **you choose the provider** and configure the
  credentials. Content you send to that provider is governed by your agreement
  with them, not by us.

We do not use ingested content, conversations, or prompts to train our own models.

---

## 4. Why we process data (purposes and legal bases)

Under the GDPR, we rely on the following legal bases. The table covers Radioso
Cloud and the website; for self-hosted deployments the operator sets its own
bases.

| Purpose | Data | GDPR legal basis |
|---|---|---|
| Provide and operate the Service | Account, ingested content, conversation, operational | Contract (Art. 6(1)(b)); for processor activities, the controller's instructions |
| Authenticate and secure accounts | Account, security/log | Contract; Legitimate interests (Art. 6(1)(f)) — securing the Service |
| Bill and manage subscriptions | Account, billing | Contract; Legal obligation (Art. 6(1)(c)) |
| Run, debug, and improve reliability | Operational, security | Legitimate interests — keeping the Service stable and safe |
| Website analytics and communication | Website, contact-form | Consent where required (Art. 6(1)(a)); otherwise Legitimate interests |
| Comply with law and respond to requests | As needed | Legal obligation |

Where we rely on **consent** (for example, certain cookies or marketing email),
you can withdraw it at any time without affecting prior processing.

---

## 5. Cookies and similar technologies (website and Cloud)

We use cookies and similar technologies to keep you signed in, remember
preferences, and understand website usage. Strictly necessary cookies are always
active; non-essential cookies are used only where you allow them, in line with
your cookie choices.

We use **PostHog** for product and website analytics. PostHog helps us understand
how the website and Service are used so we can improve them. Where required by
law, analytics run only after you give consent.

> **Confirm before publishing:** the cookie names/durations you actually set and,
> if you display a consent banner, the provider you use. If you enable PostHog
> session recording, disclose it here explicitly.

---

## 6. How we share data

We share personal data only as needed to run the Service:

- **Sub-processors and service providers** — hosting, database, AI provider,
  and analytics. The current list is in Section 6.1 below.
- **Within your organization** — workspace members and operators can see data
  according to the access controls you configure.
- **Legal and safety** — where required by law, to enforce our terms, or to
  protect rights, safety, and the integrity of the Service.
- **Business transfers** — in connection with a merger, acquisition, or asset
  sale, subject to this policy.

We do **not** sell personal data, and we do **not** "share" it for cross-context
behavioral advertising as those terms are defined under the CCPA/CPRA.

### 6.1 Current sub-processors (Radioso Cloud)

These third parties process personal data on our behalf to run Radioso Cloud.
Self-hosted deployments do not use these unless the operator chooses to.

| Sub-processor | Role | Data processed | Location |
|---|---|---|---|
| Google Cloud EMEA Ltd. (Google Cloud Platform) | Cloud hosting, compute, and managed PostgreSQL database | All Service data stored and processed in the platform | EU (europe-west, EEA) |
| PostHog Inc. | Product and website analytics | Usage events, device/browser data, approximate location | EU Cloud (eu.posthog.com), EEA |
| Configured AI providers (e.g. OpenAI, Anthropic) | Generating grounded answers | Prompts and retrieved context sent at answer time | Primarily United States **[confirm the providers you enable]** |

We update this list when sub-processors change. We do not currently use a payment
processor, because Radioso Cloud does not yet sell subscriptions online; one will
be added here before paid online billing launches.

---

## 7. International transfers

Radioso Cloud is hosted on Google Cloud Platform in an EU region (europe-west,
within the EEA), and our analytics (PostHog) run on EU Cloud. The main transfer
outside the EEA is when prompts and retrieved context are sent to AI providers
(such as OpenAI and Anthropic), which primarily process in the United States.
Where we transfer personal data outside the EEA, UK, or Switzerland, we rely on a
lawful transfer mechanism such as the EU Standard Contractual Clauses and the UK
Addendum, together with supplementary measures where needed. Copies are available
on request at the privacy contact above.

---

## 8. Retention

We keep personal data only as long as needed for the purposes above:

- **Account data** — for the life of the account, then deleted or anonymized
  within **30 days** after closure.
- **Ingested content and conversations (Cloud)** — for as long as the workspace
  keeps them, or until you delete them; deletions propagate to derived chunks and
  vectors. Backups are purged within **35 days** on our standard backup cycle.
- **Operational logs** — up to **90 days**.
- **Audit and security events** — up to **12 months**, because they support
  security investigations and abuse detection.
- **Billing and accounting records** — retained for **7 years**, as required by
  Estonian accounting law.

For self-hosted deployments, retention is controlled by the operator.

---

## 9. Security

We use technical and organizational measures appropriate to the risk, including
encryption in transit, access controls, audit logging, and least-privilege
operational practices. PostgreSQL is the system of record; application state,
documents, chunks, vectors, settings, sessions, and audit events are stored there.
No system is perfectly secure, so we cannot guarantee absolute security.

---

## 10. Your rights

### 10.1 GDPR (EEA, UK, Switzerland)

Subject to conditions and exemptions, you have the right to:

- access your personal data and receive a copy;
- correct inaccurate data;
- erase data ("right to be forgotten");
- restrict or object to processing;
- data portability;
- withdraw consent where processing is based on consent; and
- lodge a complaint with your supervisory authority.

To exercise these rights for **Radioso Cloud**, contact us at the privacy contact
above. If your data was processed through a **self-hosted** deployment, contact
the operator running it; we will assist that operator as their processor where
applicable.

### 10.2 CCPA/CPRA (California)

If you are a California resident, you have the right to:

- **know** what personal information we collect and how we use and disclose it;
- **access** and obtain a copy of that information;
- **correct** inaccurate information;
- **delete** your personal information, subject to exceptions; and
- be free from discrimination for exercising these rights.

We do not sell your personal information and do not share it for cross-context
behavioral advertising. Because we do not sell or share in that sense, no
"Do Not Sell or Share My Personal Information" action is required, but you may
still exercise the rights above by contacting us at the privacy contact. You may
use an authorized agent, and we will verify requests before acting on them.

Where we act as a **service provider** under the CCPA/CPRA (processing content on
your behalf), we use that personal information only to provide the Service and as
permitted by our agreement with you.

---

## 11. Children

The Service is not directed to children under 16, and we do not knowingly collect
their personal data. If you believe a child has provided us personal data,
contact us and we will delete it.

---

## 12. Changes to this policy

We may update this policy from time to time. We will change the "Last updated"
date above and, for material changes, give notice through the Service or by email
where appropriate. Continued use of the Service after an update means you accept
the revised policy.

---

## 13. Contact

Questions or requests about this policy or your personal data:

- **hello@radioso.ai**
- **Ljuv OÜ, Ümera tn 25-39, Lasnamäe linnaosa, 13816 Tallinn, Estonia**
