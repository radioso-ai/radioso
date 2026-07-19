/**
 * A small, self-contained corpus the conversation-quality suite grounds against. Facts
 * are concrete and quotable (a 30-day window, a $49 plan, "SOC 2 Type II") so cases can
 * assert on exact figures deterministically instead of relying only on a judge.
 *
 * Document ids are fixed UUIDs so assertions can reference them by constant.
 */
export interface ConversationQualityDocument {
  id: string;
  title: string;
  content: string;
}

export const REFUND_POLICY_DOC_ID = "22222222-2222-4222-8222-222222222201";
export const PRICING_DOC_ID = "22222222-2222-4222-8222-222222222202";
export const SECURITY_DOC_ID = "22222222-2222-4222-8222-222222222203";
export const GETTING_STARTED_DOC_ID = "22222222-2222-4222-8222-222222222204";

export const conversationQualityCorpus: ConversationQualityDocument[] = [
  {
    id: REFUND_POLICY_DOC_ID,
    title: "Refund Policy",
    content: [
      "Refund Policy",
      "",
      "Customers may request a full refund within 30 days of purchase, no questions asked.",
      "After the 30-day window, refunds are prorated for annual plans and are not available for monthly plans.",
      "To request a refund, contact support with your account email and order number.",
    ].join("\n"),
  },
  {
    id: PRICING_DOC_ID,
    title: "Plans and Pricing",
    content: [
      "Plans and Pricing",
      "",
      "The Starter plan is free and includes a single assistant and 100 documents.",
      "The Pro plan costs $49 per month and includes unlimited documents, custom branding, and priority support.",
      "The Enterprise plan is custom-priced and adds SSO, audit logs, and a dedicated success manager.",
    ].join("\n"),
  },
  {
    id: SECURITY_DOC_ID,
    title: "Security and Compliance",
    content: [
      "Security and Compliance",
      "",
      "Radioso is SOC 2 Type II compliant and undergoes annual third-party audits.",
      "All data is encrypted in transit with TLS 1.2+ and at rest with AES-256.",
      "Enterprise customers can request a data processing agreement and single sign-on.",
    ].join("\n"),
  },
  {
    id: GETTING_STARTED_DOC_ID,
    title: "Getting Started",
    content: [
      "Getting Started",
      "",
      "Create a workspace, upload your first documents, and the ingestion worker chunks and embeds them automatically.",
      "Once processing completes, ask your assistant a question to get a grounded, cited answer.",
    ].join("\n"),
  },
];
