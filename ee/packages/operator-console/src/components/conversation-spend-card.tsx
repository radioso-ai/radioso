"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";

import { formatMeterNumber } from "../lib/meter-text";
import { formatEurPerConversation } from "../lib/spend-text";
import type { ConversationSpend, OrganizationUsage } from "../lib/staff-auth-api";

function SpendMonth({ label, spend }: { label: string; spend: ConversationSpend }) {
  return (
    <div className="mt-4">
      <div className="text-xs uppercase tracking-normal text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">
        {spend.averageEurPerConversation === null ? "—" : formatEurPerConversation(spend.averageEurPerConversation)}
      </div>
      <div className="mt-1 text-sm text-zinc-400">
        {formatMeterNumber(spend.meteredConversations)} metered conversation{spend.meteredConversations === 1 ? "" : "s"}
      </div>
      {spend.flagged ? (
        <div className="mt-2 text-sm text-amber-200">
          Warn only: above the {formatEurPerConversation(spend.flagAboveEurPerConversation)} per conversation flag.
        </div>
      ) : null}
      {spend.unpricedCalls > 0 ? (
        <div className="mt-2 text-sm text-zinc-400">
          {formatMeterNumber(spend.unpricedCalls)} call{spend.unpricedCalls === 1 ? "" : "s"} on models with no list price are left out.
        </div>
      ) : null}
    </div>
  );
}

/** Model spend per metered customer conversation, this month and last, with the staff flag. */
export function ConversationSpendCard({ spend }: { spend: OrganizationUsage["conversationSpend"] }) {
  const flagged = spend.current.flagged || spend.previous.flagged;
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900 p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium tracking-normal">Model spend per conversation</h2>
        {flagged ? <AlertTriangle className="size-5 text-amber-300" /> : <CheckCircle2 className="size-5 text-emerald-300" />}
      </div>
      <SpendMonth label="This month" spend={spend.current} />
      <SpendMonth label="Last month" spend={spend.previous} />
      <div className="mt-4 text-xs text-zinc-500">At list price, with cached input charged in full.</div>
    </div>
  );
}
