"use client";

import { Button } from "@radioso/ui/button";
import { Input } from "@radioso/ui/input";
import { UserPlus } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";

import { staffAuthApi, type StaffRole, type StaffStatus, type StaffUser } from "../lib/staff-auth-api";
import { EmptyState, ErrorBanner, StaffLayout } from "./staff-layout";

const roles: StaffRole[] = ["support_read", "billing_write", "owner"];
const statuses: StaffStatus[] = ["active", "disabled"];

export function StaffPage() {
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: "", name: "", role: "support_read" as StaffRole, password: "" });
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const result = await staffAuthApi.listStaff();
    setStaff(result.staff);
  };

  useEffect(() => {
    load().catch((caught) => setError(caught instanceof Error ? caught.message : "Staff could not be loaded."));
  }, []);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await staffAuthApi.createStaff(form);
      setForm({ email: "", name: "", role: "support_read", password: "" });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Staff user could not be created.");
    } finally {
      setSaving(false);
    }
  };

  const setRole = async (staffId: string, role: StaffRole) => {
    await staffAuthApi.setStaffRole(staffId, role);
    await load();
  };

  const setStatus = async (staffId: string, status: StaffStatus) => {
    await staffAuthApi.setStaffStatus(staffId, status);
    await load();
  };

  return (
    <StaffLayout active="staff">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-normal">Staff</h1>
        <p className="mt-1 text-sm text-zinc-400">Owner-only staff identity and role management.</p>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <section className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead className="bg-zinc-900 text-left text-xs uppercase tracking-normal text-zinc-500">
              <tr>
                <th className="px-4 py-3 font-medium">Staff</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Last login</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {staff.map((member) => (
                <tr key={member.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-100">{member.name}</div>
                    <div className="text-xs text-zinc-500">{member.email}</div>
                  </td>
                  <td className="px-4 py-3">
                    <select className="h-9 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100" value={member.role} onChange={(event) => void setRole(member.id, event.target.value as StaffRole)}>
                      {roles.map((role) => <option key={role} value={role}>{role}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <select className="h-9 rounded-md border border-zinc-700 bg-zinc-950 px-2 text-sm text-zinc-100" value={member.status} onChange={(event) => void setStatus(member.id, event.target.value as StaffStatus)}>
                      {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-zinc-300">{member.lastLoginAt ? new Date(member.lastLoginAt).toLocaleString() : "never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {staff.length === 0 ? <EmptyState title="No staff users" detail="Create an owner or staff user through bootstrap first." /> : null}
        </section>
        <form onSubmit={(event) => { void create(event); }} className="rounded-md border border-zinc-800 bg-zinc-900 p-5">
          <h2 className="text-base font-medium tracking-normal">Create staff user</h2>
          <div className="mt-4 space-y-4">
            <label className="block text-sm font-medium text-zinc-200">
              Email
              <Input className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required />
            </label>
            <label className="block text-sm font-medium text-zinc-200">
              Name
              <Input className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            </label>
            <label className="block text-sm font-medium text-zinc-200">
              Role
              <select className="mt-2 h-9 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 text-sm text-zinc-100" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as StaffRole })}>
                {roles.map((role) => <option key={role} value={role}>{role}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium text-zinc-200">
              Temporary password
              <Input className="mt-2 border-zinc-700 bg-zinc-950 text-zinc-100" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required minLength={8} />
            </label>
          </div>
          <Button className="mt-5" type="submit" disabled={saving}>
            <UserPlus className="size-4" />
            {saving ? "Creating" : "Create staff"}
          </Button>
        </form>
      </div>
    </StaffLayout>
  );
}
