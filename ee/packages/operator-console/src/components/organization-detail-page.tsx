"use client";

import { Button } from "@radioso/ui/button";
import { AlertTriangle, ArrowLeft, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { formatHumanBytes } from "../lib/byte-units";
import { canWriteTiers, staffAuthApi, type AccountUsageSummary, type UsageLimitProfile, type StaffUser } from "../lib/staff-auth-api";
import { ErrorBanner, limitText, StaffLayout } from "./staff-layout";

const resourceLabels = {
  monthlyAnswers: "Monthly answers",
  storedDocuments: "Stored documents",
  storedIndexedBytes: "Stored indexed bytes",
  monthlyIndexedBytes: "Monthly indexed bytes",
} as const;

type ResourceKey = keyof typeof resourceLabels;

const resourceKeys: ResourceKey[] = ["monthlyAnswers", "storedDocuments", "storedIndexedBytes", "monthlyIndexedBytes"];

const resourceLimitText = (key: ResourceKey, limit: number | null) =>
  key.includes("IndexedBytes") ? formatHumanBytes(limit) : limitText(limit);

const resourceUsedText = (key: ResourceKey, used: number) =>
  key.includes("IndexedBytes") ? formatHumanBytes(used) : used.toLocaleString();

export function OrganizationDetailPage({ accountId }: { accountId: string }) {
  const [staff, setStaff] = useState<StaffUser | null>(null);
  const [usage, setUsage] = useState<AccountUsageSummary | null>(null);
  const [tiers, setTiers] = useState<UsageLimitProfile[]>([]);
  const [targetTier, setTargetTier] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      staffAuthApi.me(),
      staffAuthApi.getOrganizationUsage(accountId),
      staffAuthApi.listTiers(),
    ])
      .then(([me, usageResult, tierResult]) => {
        if (!mounted) {
          return;
        }
        setStaff(me.staff);
        setUsage(usageResult);
        setTargetTier(usageResult.profile?.key ?? "");
        setTiers(tierResult.tiers);
      })
      .catch((caught) => {
        if (mounted) {
          setError(caught instanceof Error ? caught.message : "Organization usage could not be loaded.");
        }
      });
    return () => {
      mounted = false;
    };
  }, [accountId]);

  const selectedTier = useMemo(
    () => tiers.find((tier) => tier.key === targetTier) ?? null,
    [targetTier, tiers],
  );
  const overLimitResources = useMemo(() => {
    if (!usage || !selectedTier) {
      return [];
    }
    return resourceKeys.filter((key) => {
      const limit = selectedTier[key === "monthlyAnswers"
        ? "monthlyAnswerLimit"
        : key === "storedDocuments"
          ? "storedDocumentLimit"
          : key === "storedIndexedBytes"
            ? "storedIndexedByteLimit"
            : "monthlyIndexedByteLimit"];
      return limit !== null && usage[key].used > limit;
    });
  }, [selectedTier, usage]);

  const changeTier = async () => {
    if (!usage) {
      return;
    }
    const current = usage.profile?.displayName ?? "no tier";
    const target = selectedTier?.displayName ?? "no tier";
    if (!window.confirm(`Change tier from ${current} to ${target}?`)) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await staffAuthApi.changeOrganizationTier(accountId, targetTier === "" ? null : targetTier);
      setUsage(result);
      setTargetTier(result.profile?.key ?? "");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Tier change failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <StaffLayout active="organizations">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <Button asChild variant="ghost" size="sm" className="mb-3">
            <Link href="/operator/organizations">
              <ArrowLeft className="size-4" />
              Organizations
            </Link>
          </Button>
          <h1 className="text-2xl font-semibold tracking-normal">{usage?.organizationName ?? "Organization usage"}</h1>
          <p className="mt-1 font-mono text-xs text-zinc-500">{accountId}</p>
        </div>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      {!usage ? <div className="py-10 text-sm text-zinc-400">Loading usage</div> : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="grid gap-4 md:grid-cols-2">
            {resourceKeys.map((key) => {
              const item = usage[key];
              const overLimit = item.limit !== null && item.used > item.limit;
              return (
                <div key={key} className="rounded-md border border-zinc-800 bg-zinc-900 p-5">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-base font-medium tracking-normal">{resourceLabels[key]}</h2>
                    {overLimit ? <AlertTriangle className="size-5 text-amber-300" /> : <CheckCircle2 className="size-5 text-emerald-300" />}
                  </div>
                  <div className="mt-4 text-2xl font-semibold">{resourceUsedText(key, item.used)}</div>
                  <div className="mt-1 text-sm text-zinc-400">Limit {resourceLimitText(key, item.limit)}</div>
                  {overLimit ? <div className="mt-3 text-sm text-amber-200">Warn only: current usage is over this limit.</div> : null}
                </div>
              );
            })}
          </section>
          <aside className="rounded-md border border-zinc-800 bg-zinc-900 p-5">
            <h2 className="text-base font-medium tracking-normal">Tier assignment</h2>
            <div className="mt-2 text-sm text-zinc-400">Current: {usage.profile?.displayName ?? "no tier"}</div>
            {staff && canWriteTiers(staff.role) ? (
              <div className="mt-5 space-y-4">
                <label className="block text-sm font-medium text-zinc-200">
                  Target tier
                  <select
                    className="mt-2 h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100"
                    value={targetTier}
                    onChange={(event) => setTargetTier(event.target.value)}
                  >
                    <option value="">no tier</option>
                    {tiers.map((tier) => (
                      <option key={tier.key} value={tier.key}>{tier.displayName}</option>
                    ))}
                  </select>
                </label>
                {overLimitResources.length > 0 ? (
                  <div className="rounded-md border border-amber-500/30 bg-amber-950/30 px-3 py-2 text-sm text-amber-100">
                    Warn only: selected tier is below current usage for {overLimitResources.map((key) => resourceLabels[key]).join(", ")}.
                  </div>
                ) : null}
                <Button onClick={changeTier} disabled={saving || targetTier === (usage.profile?.key ?? "")}>
                  Change tier
                </Button>
              </div>
            ) : (
              <div className="mt-5 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-400">
                Read-only staff can view usage but cannot change tiers.
              </div>
            )}
          </aside>
        </div>
      )}
    </StaffLayout>
  );
}
