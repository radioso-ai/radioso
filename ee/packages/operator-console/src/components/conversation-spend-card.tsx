"use client";

import { AlertTriangle, CheckCircle2, CircleHelp } from "lucide-react";

import { formatMeterNumber } from "../lib/meter-text";
import { averageText, formatEurPerConversation } from "../lib/spend-text";
import type { ConversationSpend, OrganizationUsage } from "../lib/staff-auth-api";

const callsText = (calls: number): string => `${formatMeterNumber(calls)} call${calls === 1 ? "" : "s"}`;

function SpendMonth({ label, spend }: { label: string; spend: ConversationSpend }) {
  const flag = formatEurPerConversation(spend.flagAboveEurPerConversation);
  return (
    <div className="mt-4">
      <div className="text-xs uppercase tracking-normal text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{averageText(spend)}</div>
      <div className="mt-1 text-sm text-zinc-400">
        {formatMeterNumber(spend.meteredConversations)} metered conversation{spend.meteredConversations === 1 ? "" : "s"}
      </div>
      {spend.flag === "above" ? (
        <div className="mt-2 text-sm text-amber-200">Warn only: above the {flag} per conversation flag.</div>
      ) : null}
      {spend.flag === "undetermined" ? (
        <div className="mt-2 text-sm text-zinc-300">
          Undetermined: {callsText(spend.unpricedCalls)} on models with no list price are left out, so this month may be above the {flag} flag.
        </div>
      ) : null}
      {spend.flag === "above" && spend.unpricedCalls > 0 ? (
        <div className="mt-2 text-sm text-zinc-400">
          {callsText(spend.unpricedCalls)} on models with no list price are left out, so the average is at least this.
        </div>
      ) : null}
    </div>
  );
}

function SpendIcon({ spend }: { spend: OrganizationUsage["conversationSpend"] }) {
  const flags = [spend.current.flag, spend.previous.flag];
  if (flags.includes("above")) {
    return <AlertTriangle className="size-5 text-amber-300" />;
  }
  if (flags.includes("undetermined")) {
    return <CircleHelp className="size-5 text-zinc-400" />;
  }
  return <CheckCircle2 className="size-5 text-emerald-300" />;
}

/** Model spend per metered customer conversation, this month and last, with the staff flag. */
export function ConversationSpendCard({ spend }: { spend: OrganizationUsage["conversationSpend"] }) {
  const replies = formatMeterNumber(spend.current.repliesPerConversation);
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium tracking-normal">Model spend per conversation</h2>
        <SpendIcon spend={spend} />
      </div>
      <SpendMonth label="This month" spend={spend.current} />
      <SpendMonth label="Last month" spend={spend.previous} />
      <div className="mt-4 text-xs text-zinc-500">
        At list price, with cached input charged in full. Both months are counted at the tier&apos;s current{" "}
        {replies} replies per conversation, so changing it re-counts both.
      </div>
    </div>
  );
}
