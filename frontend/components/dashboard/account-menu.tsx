'use client'

import Link from 'next/link'
import { useRef, useState, type ReactNode } from 'react'
import { Check, CreditCard, Gauge, LogOut, Monitor, Moon, Sun, UserRound, Users } from 'lucide-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useTheme, type Theme } from '@/components/theme-provider'
import { useAuth } from '@/lib/auth-context'
import { useWorkspace } from '@/lib/workspace-context'
import { buildDashboardHref, type AccountTab, type DashboardRouteState } from '@/lib/dashboard-routes'
import { editionController } from '@/lib/edition-controller'
import { enterpriseUsageApi, type AccountUsageSummary } from '@/lib/api'
import { formatPlanUsageCompact, isPlanUsageMetered, planUsageLevelTone, type PlanUsageTone } from '@/lib/plan-card-usage'
import { cn } from '@/lib/utils'

type ConversationUsage = AccountUsageSummary['monthlyConversations']

// Once fetched, the menu's conversation usage stays put for this long; opening again inside the
// window reuses it instead of re-fetching on every open.
const USAGE_MENU_CACHE_MS = 60_000

const USAGE_TONE_CLASS_NAME: Readonly<Record<PlanUsageTone, string>> = {
  ok: 'text-muted-foreground',
  warning: 'text-amber-700 dark:text-amber-300',
  destructive: 'text-destructive',
}

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]

/**
 * Account/user menu rendered as a floating popup off the sidebar profile card.
 * The card (passed as `children`) is the trigger; Radix owns open/close, keyboard
 * nav, and click-away dismissal, so selecting an item closes the menu.
 */
export function AccountMenu({
  accountId,
  routeState,
  children,
}: {
  accountId: string
  routeState: DashboardRouteState
  children: ReactNode
}) {
  const { activeWorkspace, activeWorkspaceId } = useWorkspace()
  const { theme, setTheme } = useTheme()
  const { logout } = useAuth()
  const usageMeterEnabled = editionController.canUseEnterpriseUsageLimits()
  const [conversationUsage, setConversationUsage] = useState<ConversationUsage>(null)
  const lastFetchedAtRef = useRef<number | null>(null)

  const activeTab = routeState.section === 'account' ? (routeState.accountTab ?? 'members') : undefined
  const href = (accountTab: AccountTab) =>
    buildDashboardHref(accountId, {
      section: 'account',
      accountTab,
      workspaceId: activeWorkspaceId ?? undefined,
      workspacePublicRouteKey: activeWorkspace?.publicRouteKey,
    })

  const handleOpenChange = (open: boolean) => {
    if (!open || !usageMeterEnabled) {
      return
    }

    const now = Date.now()
    if (lastFetchedAtRef.current !== null && now - lastFetchedAtRef.current < USAGE_MENU_CACHE_MS) {
      return
    }

    void enterpriseUsageApi.getAccountUsage()
      .then((response) => {
        lastFetchedAtRef.current = Date.now()
        setConversationUsage(response.monthlyConversations)
      })
      .catch(() => {
        // Leave lastFetchedAtRef untouched: a transient failure must not block the next open
        // from retrying once the backend recovers.
        setConversationUsage(null)
      })
  }

  const usageLabel = usageMeterEnabled ? 'Plan & usage' : 'Usage'
  const UsageIcon = usageMeterEnabled ? CreditCard : Gauge
  const meteredUsage = usageMeterEnabled && isPlanUsageMetered(conversationUsage) ? conversationUsage : null

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={8} className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href={href('profile')} aria-current={activeTab === 'profile' ? 'page' : undefined}>
              <UserRound />
              Profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={href('members')} aria-current={activeTab === 'members' ? 'page' : undefined}>
              <Users />
              Members
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href={href('usage')} aria-current={activeTab === 'usage' ? 'page' : undefined}>
              <UsageIcon />
              {usageLabel}
              {meteredUsage ? (
                <span className={cn('ml-auto text-xs', USAGE_TONE_CLASS_NAME[planUsageLevelTone(meteredUsage.level)])}>
                  {formatPlanUsageCompact(meteredUsage)}
                </span>
              ) : null}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Appearance
        </DropdownMenuLabel>
        {THEME_OPTIONS.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => setTheme(option.value)}>
            <option.icon />
            {option.label}
            <Check className={cn('ml-auto size-4', theme === option.value ? 'opacity-100' : 'opacity-0')} />
          </DropdownMenuItem>
        ))}

        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => void logout()}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
