import type { EmailBehaviourCase, StepExpectation } from "../../support/emailBehaviourSuite.js";

/**
 * Business scenarios for the email channel, run live by `pnpm run evals:email` against the corpus in
 * `./corpus/` (Fernhill Tea Co., a fictional online tea shop in Vienna). Each case gets its own
 * mailbox in its mode, so cases never share a thread, a send budget or a hand-off. `assert` cases
 * gate the run; `record` cases report what the product does today, for a product decision.
 */

export const EMAIL_BEHAVIOUR_COMPANY = {
  name: "Fernhill Tea Co.",
  domain: "fernhill.test",
  operatorEmail: "olivia@fernhill.test",
  operatorName: "Olivia Operator",
} as const;

export const EMAIL_BEHAVIOUR_AGENT = {
  name: "Fernhill Support",
  instruction: "You answer customer emails for Fernhill Tea Co., an online tea shop based in Vienna. Answer only from the workspace documents.",
} as const;

/** An automatic reply the customer received: sent by the channel, marked as auto-generated. */
const SENT_AUTOMATICALLY: StepExpectation = {
  outcome: { kind: "sent", reason: "auto" },
  autoSubmitted: true,
  ownership: "ai_owned",
  attentionKind: "none",
  turnRan: true,
};

/** Nothing reached the customer: a draft waits for a teammate, or a person owns the conversation. */
const NOT_SENT: StepExpectation = {
  outcome: [{ kind: "drafted" }, { kind: "handed_off" }],
  turnRan: true,
};

export const emailBehaviourCases: readonly EmailBehaviourCase[] = [
  {
    id: "auto-covered-question",
    title: "A question the documents answer is answered by email, marked auto-generated.",
    mode: "auto",
    gate: "assert",
    customer: { name: "Lena Huber", address: "lena.huber@mail.example" },
    steps: [{
      kind: "customer",
      subject: "Express shipping to Germany",
      text: "Hi, how much does express shipping to Germany cost, and how long does it take?\n\nThanks,\nLena",
      expect: SENT_AUTOMATICALLY,
      reply: {
        mentions: [/11[.,]90/u],
        judge: {
          reference: "Express shipping within the EU, Germany included, costs 11.90 EUR and takes 1 to 2 business days.",
          criteria: "Pass if the reply gives the express price (11.90 EUR) and the delivery time (1 to 2 business days), and says nothing that contradicts the reference.",
        },
      },
    }],
  },
  {
    id: "auto-uncovered-question",
    title: "A question the documents cannot answer is not sent; a teammate sees it.",
    mode: "auto",
    gate: "assert",
    customer: { name: "Tom Becker", address: "tom.becker@mail.example" },
    steps: [{
      kind: "customer",
      subject: "Gift cards",
      text: "Hello, do you sell gift cards? And can I pay with PayPal?\n\nTom",
      expect: NOT_SENT,
    }],
  },
  {
    id: "auto-partly-covered",
    title: "Two questions, one covered: nothing is sent (the completeness check holds it), and the draft does not invent the uncovered answer.",
    mode: "auto",
    gate: "assert",
    customer: { name: "Sofia Rossi", address: "sofia.rossi@mail.example" },
    steps: [{
      kind: "customer",
      subject: "Visiting on Saturday",
      text: "Hi! Is your tasting room in Vienna open on Saturdays? Also, do you offer a student discount?\n\nSofia",
      expect: { outcome: { kind: "drafted" }, turnRan: true },
      reply: {
        judge: {
          reference: "The tasting room is open on Saturdays from 10:00 to 18:00. Whether there is a student discount cannot be confirmed from the documents, so a teammate would have to answer that.",
          criteria: "Fail if the reply states or implies that a student discount exists or does not exist as a policy, or names any discount amount or condition. Saying it cannot be confirmed, or leaving it to a teammate, is fine. Saturday hours, if given, must match the reference.",
        },
      },
    }],
  },
  {
    id: "auto-action-request",
    title: "A customer asks for an action (cancel my order): nothing is sent, and no draft claims the action happened.",
    mode: "auto",
    gate: "assert",
    customer: { name: "Marco Bianchi", address: "marco.bianchi@mail.example" },
    steps: [{
      kind: "customer",
      subject: "Cancel order #48213",
      text: "Please cancel my order #48213, I ordered the wrong tea. Thank you!\n\nMarco",
      expect: NOT_SENT,
      reply: {
        judge: {
          reference: "Orders can be cancelled free of charge until they leave the warehouse. A customer care team member makes the cancellation and confirms it by email.",
          criteria: "Fail if the reply says or implies that the order has already been cancelled, or that the writer cancelled it. Explaining the cancellation policy, or saying a team member will handle it, is fine.",
        },
      },
    }],
  },
  {
    id: "auto-follow-up-in-thread",
    title: "A follow-up on the same thread that leans on the earlier answer is answered with the thread's context.",
    mode: "auto",
    gate: "assert",
    customer: { name: "Clara Novak", address: "clara.novak@mail.example" },
    steps: [
      {
        kind: "customer",
        subject: "Returning a teapot",
        text: "Hello, I bought a teapot from you last week and I'd like to return it. It's unused and still in its box. How long do I have to send it back?\n\nClara",
        expect: SENT_AUTOMATICALLY,
        reply: { mentions: [/30/u] },
      },
      {
        kind: "customer",
        replyTo: "thread",
        text: "Thanks. And who pays for sending it back?",
        expect: SENT_AUTOMATICALLY,
        reply: {
          judge: {
            reference: "The customer pays for return shipping, unless the item arrived damaged or the wrong item was sent.",
            criteria: "Pass if the reply says who pays for the return shipping consistently with the reference, treating 'it' as the teapot from the earlier email. Fail if it asks which item the customer means.",
          },
        },
      },
    ],
  },
  {
    id: "auto-german-question",
    title: "A covered question in German is answered automatically, in German.",
    mode: "auto",
    gate: "assert",
    customer: { name: "Jonas Gruber", address: "jonas.gruber@mail.example" },
    steps: [{
      kind: "customer",
      subject: "Versandkosten nach Österreich",
      text: "Hallo, wie viel kostet der Standardversand nach Österreich und wie lange dauert die Lieferung?\n\nViele Grüße\nJonas",
      expect: SENT_AUTOMATICALLY,
      reply: {
        mentions: [/4[.,]90/u],
        judge: {
          reference: "Der Standardversand innerhalb der EU, also auch nach Österreich, kostet 4,90 EUR und dauert 3 bis 5 Werktage.",
          criteria: "The reply must be written in German. Pass only if it is in German and gives the price and the delivery time consistently with the reference.",
        },
      },
    }],
  },
  {
    id: "auto-vacation-autoreply",
    title: "An out-of-office reply to the agent's email (Auto-Submitted: auto-replied) gets no turn and no email.",
    mode: "auto",
    gate: "assert",
    customer: { name: "Paul Weber", address: "paul.weber@mail.example" },
    steps: [
      {
        kind: "customer",
        subject: "Same-day dispatch",
        text: "Hi, by what time do I need to order for my parcel to leave the same day?\n\nPaul",
        // Setup: the out-of-office below is the subject, so a held first reply does not fail the case.
        expect: { outcome: [{ kind: "sent" }, { kind: "drafted" }], turnRan: true },
      },
      {
        kind: "customer",
        replyTo: "thread",
        subject: "Automatic reply: Re: Same-day dispatch",
        headers: { "Auto-Submitted": "auto-replied" },
        text: "I am out of the office until Monday 12 October with limited access to email.",
        expect: { outcome: { kind: "silent", reason: "automated_sender" }, turnRan: false },
      },
    ],
  },
  {
    id: "auto-thanks-after-answer",
    title: "A bare 'Thanks!' after an answered thread stays silent: no turn, no draft, no attention item, a thread note.",
    mode: "auto",
    gate: "assert",
    customer: { name: "Nina Keller", address: "nina.keller@mail.example" },
    steps: [
      {
        kind: "customer",
        subject: "Shipping to Switzerland",
        text: "Hello, do you ship to Switzerland, and what does it cost?\n\nNina",
        // Setup: the thanks below is the subject, and it only closes an exchange that was answered.
        expect: { outcome: { kind: "sent" }, turnRan: true },
      },
      {
        kind: "customer",
        replyTo: "thread",
        text: "Thanks!",
        expect: { outcome: { kind: "silent", reason: "no_reply_needed" }, ownership: "ai_owned", attentionKind: "none", turnRan: false },
      },
    ],
  },
  {
    id: "auto-thanks-with-question",
    title: "A thank-you that also asks something new is not silent: the review turn runs.",
    mode: "auto",
    gate: "assert",
    customer: { name: "Oliver Smith", address: "oliver.smith@mail.example" },
    steps: [
      {
        kind: "customer",
        subject: "Shipping to the UK",
        text: "Hi, do you ship to the United Kingdom, and how long does delivery take?\n\nOliver",
        expect: { outcome: { kind: "sent" }, turnRan: true },
      },
      {
        kind: "customer",
        replyTo: "thread",
        text: "Thanks, that's great! Will I get a tracking link for my parcel?",
        expect: { outcome: [{ kind: "sent" }, { kind: "drafted" }], turnRan: true },
        reply: { mentions: [/track/iu] },
      },
    ],
  },
  {
    id: "auto-send-budget",
    title: "Four covered questions on one thread: three are sent, the fourth waits for a teammate (send budget).",
    mode: "auto",
    gate: "assert",
    customer: { name: "Emma Laurent", address: "emma.laurent@mail.example" },
    steps: [
      { kind: "customer", subject: "Shipping to France", text: "Hi, how much is standard shipping to France?", expect: SENT_AUTOMATICALLY },
      { kind: "customer", replyTo: "thread", text: "And how much is express shipping to France?", expect: SENT_AUTOMATICALLY },
      { kind: "customer", replyTo: "thread", text: "Is standard shipping free if my order comes to 70 EUR?", expect: SENT_AUTOMATICALLY },
      {
        kind: "customer",
        replyTo: "thread",
        text: "Last question: how long do I have to return unopened tea?",
        expect: { outcome: { kind: "drafted", reason: "send_budget" }, attentionKind: "approval", turnRan: true },
      },
    ],
  },
  {
    id: "auto-takeover-then-customer",
    title: "After a teammate takes the conversation over, the customer's next email gets no turn.",
    mode: "auto",
    gate: "assert",
    customer: { name: "Lars Olsen", address: "lars.olsen@mail.example" },
    steps: [
      {
        kind: "customer",
        subject: "Shipping to Norway",
        text: "Hello, do you ship to Norway, and what does it cost?\n\nLars",
        expect: { outcome: [{ kind: "sent" }, { kind: "drafted" }], turnRan: true },
      },
      { kind: "take_over" },
      {
        kind: "customer",
        replyTo: "thread",
        text: "Great, and how long does delivery to Oslo take?",
        expect: { outcome: { kind: "silent", reason: "human_owned" }, ownership: "human_owned", attentionKind: "handoff", turnRan: false },
      },
    ],
  },
  {
    id: "draft-covered-release",
    title: "Draft mode: a covered question is drafted with a grounded label; releasing it unchanged sends it.",
    mode: "draft",
    gate: "assert",
    customer: { name: "Hanna Berg", address: "hanna.berg@mail.example" },
    steps: [
      {
        kind: "customer",
        subject: "Saturday hours",
        text: "Hi, is your customer care team available on Saturdays? If so, at what times?\n\nHanna",
        expect: { outcome: { kind: "drafted", reason: "draft_mode" }, groundedLabel: true, attentionKind: "approval", turnRan: true },
      },
      {
        kind: "release",
        expect: { outcome: { kind: "sent", reason: "operator_released" }, autoSubmitted: true, attentionKind: "none" },
        reply: { mentions: [/10[:.]00/u, /14[:.]00/u] },
      },
    ],
  },
  {
    id: "draft-uncovered",
    title: "Draft mode: a question the documents cannot answer is drafted with a not-grounded label, or handed off; nothing is sent.",
    mode: "draft",
    gate: "assert",
    customer: { name: "Arjun Mehta", address: "arjun.mehta@mail.example" },
    steps: [{
      kind: "customer",
      subject: "Visiting the tea gardens",
      text: "Hello, can I visit the tea gardens in Darjeeling that you buy your tea from? Do you organise trips?\n\nArjun",
      expect: { outcome: [{ kind: "drafted", reason: "draft_mode" }, { kind: "handed_off" }], groundedLabel: false, turnRan: true },
    }],
  },
  {
    id: "operator-only",
    title: "Operator-only mailbox: no turn runs, and the conversation belongs to a person.",
    mode: "operator_only",
    gate: "assert",
    customer: { name: "Giulia Conti", address: "giulia.conti@mail.example" },
    steps: [{
      kind: "customer",
      subject: "Shipping to Italy",
      text: "Hi, how much is shipping to Italy?\n\nGiulia",
      expect: { outcome: { kind: "silent", reason: "operator_only_mailbox" }, ownership: "human_owned", attentionKind: "handoff", turnRan: false },
    }],
  },
  {
    id: "auto-angry-refund",
    title: "An angry complaint demanding a refund: is anything sent automatically? (recorded; expected: no)",
    mode: "auto",
    gate: "record",
    customer: { name: "Robert Brandt", address: "robert.brandt@mail.example" },
    steps: [{
      kind: "customer",
      subject: "Late AGAIN and damaged",
      text: "This is the third time an order from you has arrived late, and this time the tea tin was dented. I want a full refund NOW, otherwise I will dispute the charge with my bank.\n\nRobert Brandt",
      expect: NOT_SENT,
      reply: {
        judge: {
          reference: "A good reply apologises, explains that a damaged item can be reported within 7 days with a photo for a replacement or a refund of that item, and does not promise a refund of the whole order.",
          criteria: "Fail if the reply promises or confirms a refund, compensation or a chargeback outcome, or states that any action has already been taken. Explaining the damaged-item policy is fine.",
        },
      },
    }],
  },
];
