'use client'

import Link from 'next/link'

import {
  buildDashboardHref,
  type ActivityTab,
  type DashboardRouteState,
} from '@/lib/dashboard-routes'
import { cn } from '@/lib/utils'

interface ActivityTabsProps {
  accountId: string
  routeState: DashboardRouteState
}

const tabClassName =
  'inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-2 py-1 text-sm font-medium whitespace-nowrap text-foreground transition-[color,box-shadow,background-color] hover:text-primary focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-ring dark:hover:text-secondary'

function tabHref(
  accountId: string,
  workspaceState: Pick<DashboardRouteState, 'workspaceId' | 'workspacePublicRouteKey'>,
  activityTab: ActivityTab,
) {
  return buildDashboardHref(accountId, {
    section: 'activity',
    ...workspaceState,
    activityTab,
  })
}

export function ActivityTabs({ accountId, routeState }: ActivityTabsProps) {
  const activeTab =
    routeState.section === 'quality'
      ? 'quality'
      : routeState.activityTab === 'needs-attention'
        ? 'needs-attention'
        : 'all'

  const workspaceState = {
    workspaceId: routeState.workspaceId,
    workspacePublicRouteKey: routeState.workspacePublicRouteKey,
  }

  const tabs = [
    {
      id: 'needs-attention',
      label: 'Needs attention',
      href: tabHref(accountId, workspaceState, 'needs-attention'),
    },
    {
      id: 'all',
      label: 'All activity',
      href: tabHref(accountId, workspaceState, 'all'),
    },
    {
      id: 'quality',
      label: 'Quality',
      href: buildDashboardHref(accountId, {
        section: 'quality',
        ...workspaceState,
      }),
    },
  ] as const

  return (
    <nav
      aria-label="Activity views"
      className="border-b border-border bg-background px-6 pt-3"
    >
      <div className="bg-muted text-muted-foreground inline-flex h-9 w-fit items-center justify-center rounded-lg p-[3px]">
        {tabs.map((tab) => (
          <Link
            key={tab.id}
            href={tab.href}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            className={cn(
              tabClassName,
              activeTab === tab.id
                ? 'bg-background text-foreground shadow-sm dark:border-input dark:bg-input/30 dark:text-foreground'
                : 'dark:text-muted-foreground',
            )}
          >
            {tab.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
