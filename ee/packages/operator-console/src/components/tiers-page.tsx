"use client";

import { Button } from "@radioso/ui/button";
import { Input } from "@radioso/ui/input";
import { Pencil, Plus } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

import { formatHumanBytes, formatNullableByteInput, parseNullableHumanBytes } from "../lib/byte-units";
import { canWriteTiers, staffAuthApi, type StaffUser, type UsageLimitProfile } from "../lib/staff-auth-api";
import { EmptyState, ErrorBanner, limitText, StaffLayout } from "./staff-layout";

const emptyForm = {
  key: "",
  displayName: "",
  monthlyAnswerLimit: "",
  storedDocumentLimit: "",
  storedIndexedByteLimit: "",
  monthlyIndexedByteLimit: "",
};

export function TiersPage() {
  const [staff, setStaff] = useState<StaffUser | null>(null);
  const [tiers, setTiers] = useState<UsageLimitProfile[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const [me, result] = await Promise.all([staffAuthApi.me(), staffAuthApi.listTiers()]);
    setStaff(me.staff);
    setTiers(result.tiers);
  };

  useEffect(() => {
    load().catch((caught) => setError(caught instanceof Error ? caught.message : "Tiers could not be loaded."));
  }, []);

  const edit = (tier: UsageLimitProfile) => {
    setEditingKey(tier.key);
    setForm({
      key: tier.key,
      displayName: tier.displayName,
      monthlyAnswerLimit: tier.monthlyAnswerLimit === null ? "" : String(tier.monthlyAnswerLimit),
      storedDocumentLimit: tier.storedDocumentLimit === null ? "" : String(tier.storedDocumentLimit),
      storedIndexedByteLimit: formatNullableByteInput(tier.storedIndexedByteLimit),
      monthlyIndexedByteLimit: formatNullableByteInput(tier.monthlyIndexedByteLimit),
    });
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const key = form.key.trim();
      await staffAuthApi.upsertTier(key, {
        displayName: form.displayName.trim(),
        monthlyAnswerLimit: form.monthlyAnswerLimit.trim() === "" ? null : Number(form.monthlyAnswerLimit),
        storedDocumentLimit: form.storedDocumentLimit.trim() === "" ? null : Number(form.storedDocumentLimit),
        storedIndexedByteLimit: parseNullableHumanBytes(form.storedIndexedByteLimit),
        monthlyIndexedByteLimit: parseNullableHumanBytes(form.monthlyIndexedByteLimit),
      });
      setForm(emptyForm);
      setEditingKey(null);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Tier could not be saved.");
    } finally {
      setSaving(false);
    }
  };

  const canWrite = staff ? canWriteTiers(staff.role) : false;

  return (
    <StaffLayout active="tiers">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-normal">Usage tiers</h1>
        <p className="mt-1 text-sm text-zinc-400">Profiles and limits used by organization assignments.</p>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <section className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead className="bg-zinc-900 text-left text-xs uppercase tracking-normal text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">Tier</th>
                <th className="px-4 py-3 font-medium">Answers</th>
                <th className="px-4 py-3 font-medium">Documents</th>
                <th className="px-4 py-3 font-medium">Stored bytes</th>
                <th className="px-4 py-3 font-medium">Monthly bytes</th>
                <th className="px-4 py-3 font-medium">Edit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {tiers.map((tier) => (
                <tr key={tier.key}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-100">{tier.displayName}</div>
                    <div className="text-xs text-zinc-500">{tier.key}</div>
                  </td>
                  <td className="px-4 py-3 text-zinc-300">{limitText(tier.monthlyAnswerLimit)}</td>
                  <td className="px-4 py-3 text-zinc-300">{limitText(tier.storedDocumentLimit)}</td>
                  <td className="px-4 py-3 text-zinc-300">{formatHumanBytes(tier.storedIndexedByteLimit)}</td>
                  <td className="px-4 py-3 text-zinc-300">{formatHumanBytes(tier.monthlyIndexedByteLimit)}</td>
                  <td className="px-4 py-3">
                    {canWrite ? (
                      <Button variant="ghost" size="sm" onClick={() => edit(tier)} aria-label={`Edit ${tier.displayName}`}>
                        <Pencil className="size-4" />
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {tiers.length === 0 ? <EmptyState title="No tiers" detail="Create a tier to make it assignable." /> : null}
        </section>
        {canWrite ? (
          <form onSubmit={submit} className="rounded-md border border-zinc-800 bg-zinc-900 p-5">
            <h2 className="text-base font-medium tracking-normal">{editingKey ? "Edit tier" : "Create tier"}</h2>
            <div className="mt-4 space-y-4">
              <label className="block text-sm font-medium text-zinc-200">
                Key
                <Input className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100" value={form.key} disabled={editingKey !== null} onChange={(event) => setForm({ ...form, key: event.target.value })} required />
              </label>
              <label className="block text-sm font-medium text-zinc-200">
                Display name
                <Input className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100" value={form.displayName} onChange={(event) => setForm({ ...form, displayName: event.target.value })} required />
              </label>
              <label className="block text-sm font-medium text-zinc-200">
                Monthly answer limit
                <Input className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100" type="number" min="0" value={form.monthlyAnswerLimit} placeholder="unlimited" onChange={(event) => setForm({ ...form, monthlyAnswerLimit: event.target.value })} />
              </label>
              <label className="block text-sm font-medium text-zinc-200">
                Stored document limit
                <Input className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100" type="number" min="0" value={form.storedDocumentLimit} placeholder="unlimited" onChange={(event) => setForm({ ...form, storedDocumentLimit: event.target.value })} />
              </label>
              <label className="block text-sm font-medium text-zinc-200">
                Stored indexed byte limit
                <Input className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100" value={form.storedIndexedByteLimit} placeholder="unlimited or 512 MB" onChange={(event) => setForm({ ...form, storedIndexedByteLimit: event.target.value })} />
              </label>
              <label className="block text-sm font-medium text-zinc-200">
                Monthly indexed byte limit
                <Input className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100" value={form.monthlyIndexedByteLimit} placeholder="unlimited or 1 GB" onChange={(event) => setForm({ ...form, monthlyIndexedByteLimit: event.target.value })} />
              </label>
            </div>
            <div className="mt-5 flex gap-2">
              <Button type="submit" disabled={saving}>
                <Plus className="size-4" />
                {saving ? "Saving" : "Save tier"}
              </Button>
              {editingKey ? <Button type="button" variant="outline" onClick={() => { setEditingKey(null); setForm(emptyForm); }}>Cancel</Button> : null}
            </div>
          </form>
        ) : (
          <aside className="rounded-md border border-zinc-800 bg-zinc-900 p-5 text-sm text-zinc-400">
            Read-only staff can view tier limits but cannot edit the catalog.
          </aside>
        )}
      </div>
    </StaffLayout>
  );
}
