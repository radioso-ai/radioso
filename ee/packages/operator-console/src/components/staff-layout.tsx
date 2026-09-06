"use client";

import { Button } from "@radioso/ui/button";
import { cn } from "@radioso/ui/utils";
import { Building2, LogOut, Shield, Tags, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { canManageStaff, staffAuthApi, type StaffUser } from "../lib/staff-auth-api";

const navItems = [
  { href: "/operator/organizations", label: "Organizations", icon: Building2 },
  { href: "/operator/tiers", label: "Tiers", icon: Tags },
] as const;

export function StaffLayout({ children, active }: { children: ReactNode; active: "organizations" | "tiers" | "staff" }) {
  const [staff, setStaff] = useState<StaffUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    staffAuthApi.me()
      .then((result) => {
        if (mounted) {
          setStaff(result.staff);
        }
      })
      .catch(() => {
        window.location.href = "/operator/login";
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, []);

  const logout = async () => {
    await staffAuthApi.logout().catch(() => undefined);
    window.location.href = "/operator/login";
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-zinc-950 text-zinc-100">
        <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-6">
          <div className="text-sm text-zinc-400">Loading operator console</div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-4 border-b border-zinc-800 pb-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md border border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
              <Shield className="size-5" />
            </div>
            <div>
              <div className="text-lg font-semibold tracking-normal">Operator Console</div>
              <div className="text-sm text-zinc-400">{staff?.name} · {staff?.role}</div>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-2">
            {navItems.map((item) => {
              const Icon = item.icon;
              const itemActive = active === item.label.toLowerCase();
              return (
                <Button key={item.href} asChild variant={itemActive ? "secondary" : "ghost"} size="sm">
                  <Link href={item.href}>
                    <Icon className="size-4" />
                    {item.label}
                  </Link>
                </Button>
              );
            })}
            {staff && canManageStaff(staff.role) ? (
              <Button asChild variant={active === "staff" ? "secondary" : "ghost"} size="sm">
                <Link href="/operator/staff">
                  <Users className="size-4" />
                  Staff
                </Link>
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={() => { void logout(); }}
              className="border-zinc-700 bg-transparent text-zinc-200 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <LogOut className="size-4" />
              Sign out
            </Button>
          </nav>
        </header>
        <section className={cn("flex-1 py-6", loading && "opacity-70")}>{children}</section>
      </div>
    </main>
  );
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-8 text-center">
      <div className="text-base font-medium text-zinc-100">{title}</div>
      <div className="mt-2 text-sm text-zinc-400">{detail}</div>
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-md border border-red-500/30 bg-red-950/40 px-4 py-3 text-sm text-red-100">
      {message}
    </div>
  );
}

export function limitText(limit: number | null): string {
  return limit === null ? "unlimited" : limit.toLocaleString();
}
