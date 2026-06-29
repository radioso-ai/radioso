"use client";

import { Button } from "@radioso/ui/button";
import { DashboardPagination } from "@radioso/ui/dashboard-pagination";
import { Input } from "@radioso/ui/input";
import { ArrowRight, Search } from "lucide-react";
import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

import { staffAuthApi, type OrganizationDirectoryPage } from "../lib/staff-auth-api";
import { EmptyState, ErrorBanner, limitText, StaffLayout } from "./staff-layout";

export function OrganizationsPage() {
  const [page, setPage] = useState<OrganizationDirectoryPage | null>(null);
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    staffAuthApi.listOrganizations({ limit: 25, offset, search })
      .then((result) => {
        if (mounted) {
          setPage(result);
          setError(null);
        }
      })
      .catch((caught) => {
        if (mounted) {
          setError(caught instanceof Error ? caught.message : "Organizations could not be loaded.");
        }
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [offset, search]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setOffset(0);
    setSearch(String(data.get("search") ?? ""));
  };

  return (
    <StaffLayout active="organizations">
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal">Organizations</h1>
          <p className="mt-1 text-sm text-zinc-400">Customer accounts, owner emails, tiers, and monthly answer usage.</p>
        </div>
        <form onSubmit={submitSearch} className="flex w-full gap-2 md:w-96">
          <Input name="search" placeholder="Search org or owner" className="border-zinc-700 bg-zinc-900 text-zinc-100" />
          <Button type="submit" variant="secondary">
            <Search className="size-4" />
            Search
          </Button>
        </form>
      </div>
      {error ? <ErrorBanner message={error} /> : null}
      <div className="overflow-hidden rounded-md border border-zinc-800 bg-zinc-900">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead className="bg-zinc-900 text-left text-xs uppercase tracking-normal text-zinc-500">
            <tr>
              <th className="px-4 py-3 font-medium">Organization</th>
              <th className="px-4 py-3 font-medium">Owner</th>
              <th className="px-4 py-3 font-medium">Tier</th>
              <th className="px-4 py-3 font-medium">Monthly answers</th>
              <th className="px-4 py-3 font-medium">Open</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {page?.rows.map((row) => (
              <tr key={row.accountId} className="hover:bg-zinc-800/60">
                <td className="px-4 py-3 font-medium text-zinc-100">{row.name}</td>
                <td className="px-4 py-3 text-zinc-300">
                  {row.ownerEmail ?? "no owner"}
                  {row.ownerCount > 1 ? <span className="ml-2 text-xs text-zinc-500">+{row.ownerCount - 1}</span> : null}
                </td>
                <td className="px-4 py-3 text-zinc-300">{row.profileDisplayName ?? "no tier"}</td>
                <td className="px-4 py-3 text-zinc-300">
                  {row.monthlyAnswers.used.toLocaleString()} / {limitText(row.monthlyAnswers.limit)}
                </td>
                <td className="px-4 py-3">
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/operator/organizations/${row.accountId}`} aria-label={`Open ${row.name}`}>
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && page?.rows.length === 0 ? <EmptyState title="No organizations found" detail="Try a different search." /> : null}
        {loading ? <div className="px-4 py-8 text-center text-sm text-zinc-400">Loading organizations</div> : null}
      </div>
      {page ? (
        <div className="mt-4">
          <DashboardPagination
            summary={`${page.pageInfo.total.toLocaleString()} organization${page.pageInfo.total === 1 ? "" : "s"}`}
            currentPage={Math.floor(page.pageInfo.offset / page.pageInfo.limit) + 1}
            totalPages={Math.max(1, Math.ceil(page.pageInfo.total / page.pageInfo.limit))}
            previousHref="#"
            nextHref="#"
            canPrevious={page.pageInfo.offset > 0}
            canNext={page.pageInfo.hasMore}
            onPrevious={() => setOffset(Math.max(0, page.pageInfo.offset - page.pageInfo.limit))}
            onNext={() => setOffset(page.pageInfo.nextOffset ?? offset)}
          />
        </div>
      ) : null}
    </StaffLayout>
  );
}
