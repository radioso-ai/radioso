'use client'

/**
 * Throwaway visual prototype for the three-column navigation model.
 * Not wired to routing or data — mock state only, so it renders without auth.
 * Delete once the IA direction is locked and the real shell is built.
 *
 * Header band: each column's header is the selection from the column to its
 * left, all aligned to the sun logo — [logo] | area | item — so the columns
 * themselves read as the breadcrumb.
 */

import Image from 'next/image'
import { useState } from 'react'
import {
  Activity,
  Bot,
  BookOpen,
  Boxes,
  Building2,
  ChevronDown,
  FileText,
  FlaskConical,
  FolderOpen,
  Globe,
  KeyRound,
  Layers,
  Link as LinkIcon,
  MessageSquare,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Wrench,
} from 'lucide-react'

import { cn } from '@/lib/utils'

type AreaId = 'agents' | 'knowledge' | 'activity' | 'quality' | 'eval' | 'settings'

type NavItem = {
  id: string
  label: string
  icon: typeof Bot
  group?: string
  status?: 'on' | 'off'
  danger?: boolean
}

type AreaConfig = {
  id: AreaId
  label: string
  icon: typeof Bot
  hasSwitcher?: boolean
  items: NavItem[]
  footer?: NavItem
}

const AREAS: AreaConfig[] = [
  {
    id: 'agents',
    label: 'Agents',
    icon: Bot,
    hasSwitcher: true,
    items: [
      { id: 'chat', label: 'Chat', icon: MessageSquare },
      { id: 'identity', label: 'Identity & appearance', icon: UserRound, group: 'Assistant' },
      { id: 'behavior', label: 'Behavior', icon: SlidersHorizontal, group: 'Assistant' },
      { id: 'skills', label: 'Skills', icon: Wrench, group: 'Assistant' },
      { id: 'public-chat-link', label: 'Public chat link', icon: LinkIcon, group: 'Channels', status: 'on' },
      { id: 'website-embed', label: 'Website widget', icon: Globe, group: 'Channels', status: 'on' },
      { id: 'api-channel', label: 'API', icon: KeyRound, group: 'Channels', status: 'off' },
      { id: 'mcp-channel', label: 'MCP', icon: Plug, group: 'Channels', status: 'off' },
    ],
    footer: { id: 'danger', label: 'Danger zone', icon: Trash2, danger: true },
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    icon: BookOpen,
    items: [
      { id: 'documents', label: 'Documents', icon: FileText },
      { id: 'sources', label: 'Sources', icon: FolderOpen },
      { id: 'ingestion', label: 'Ingestion', icon: Layers },
      { id: 'retrieval', label: 'Retrieval', icon: Search },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    items: [
      { id: 'workspace', label: 'Workspace', icon: Building2 },
      { id: 'providers', label: 'Providers', icon: Boxes },
    ],
  },
  { id: 'activity', label: 'Activity', icon: Activity, items: [] },
  { id: 'quality', label: 'Quality', icon: ShieldAlert, items: [] },
  { id: 'eval', label: 'Eval', icon: FlaskConical, items: [] },
]

const RAIL_ORDER: AreaId[] = ['agents', 'knowledge', 'activity', 'quality', 'eval', 'settings']
const RAIL = RAIL_ORDER.map((id) => AREAS.find((area) => area.id === id)!)

// Shared header-band height so the logo, area name, and item title line up.
const HEADER = 'flex h-14 shrink-0 items-center'

const allItems = (area: AreaConfig) => (area.footer ? [...area.items, area.footer] : area.items)
const firstItemId = (area: AreaConfig) => allItems(area)[0]?.id ?? ''

export default function NavPrototypePage() {
  const [areaId, setAreaId] = useState<AreaId>('agents')
  const [selectedByArea, setSelectedByArea] = useState<Record<string, string>>({ agents: 'website-embed' })

  const area = AREAS.find((entry) => entry.id === areaId)!
  const hasSubNav = area.items.length > 0
  const selected = selectedByArea[areaId] ?? firstItemId(area)

  const selectArea = (next: AreaId) => setAreaId(next)
  const selectItem = (itemId: string) => setSelectedByArea((current) => ({ ...current, [areaId]: itemId }))

  const selectedItem = allItems(area).find((entry) => entry.id === selected)
  const contentTitle = hasSubNav ? selectedItem?.label ?? area.label : area.label

  return (
    <div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
      <IconRail areas={RAIL} activeArea={areaId} collapsed={hasSubNav} onSelect={selectArea} />

      {hasSubNav ? (
        <aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
          {area.hasSwitcher ? (
            <AgentSwitcher />
          ) : (
            <div className={cn(HEADER, 'border-b border-sidebar-border px-4')}>
              <span className="truncate font-display text-lg font-semibold">{area.label}</span>
            </div>
          )}
          <SubNav area={area} selected={selected} onSelect={selectItem} />
        </aside>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className={cn(HEADER, 'border-b border-border px-6')}>
          <span className="truncate font-display text-lg font-semibold">{contentTitle}</span>
        </div>
        <ContentPane />
      </main>
    </div>
  )
}

function IconRail({
  areas,
  activeArea,
  collapsed,
  onSelect,
}: {
  areas: AreaConfig[]
  activeArea: AreaId
  collapsed: boolean
  onSelect: (id: AreaId) => void
}) {
  return (
    <nav
      className={cn(
        'flex shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200',
        collapsed ? 'w-14' : 'w-56',
      )}
    >
      <div className={cn(HEADER, 'border-b border-sidebar-border', collapsed ? 'justify-center px-2' : 'gap-2 px-4')}>
        <Image src="/radioso-icon.svg" alt="radioso" width={28} height={28} priority loading="eager" className="h-7 w-7 shrink-0" />
        {!collapsed ? <span className="truncate font-display text-lg font-semibold">radioso</span> : null}
      </div>

      <div className={cn('flex flex-1 flex-col gap-1 py-3', collapsed ? 'items-center px-2' : 'px-3')}>
        {areas.map((entry) => {
          const isActive = entry.id === activeArea
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => onSelect(entry.id)}
              title={entry.label}
              className={cn(
                'flex items-center rounded-md text-sm transition-colors',
                collapsed ? 'h-9 w-9 justify-center' : 'h-9 gap-3 px-3',
                isActive
                  ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                  : 'text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              )}
            >
              <entry.icon className={cn('h-[18px] w-[18px] shrink-0', isActive && 'text-secondary')} />
              {!collapsed ? <span className="truncate">{entry.label}</span> : null}
            </button>
          )
        })}
      </div>

      <div className={cn('flex shrink-0 pb-3', collapsed ? 'justify-center px-2' : 'px-4')}>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-secondary/60 to-primary/40 text-xs font-semibold text-sidebar-foreground">
          D
        </div>
      </div>
    </nav>
  )
}

function AgentSwitcher() {
  const [open, setOpen] = useState(false)
  return (
    <div className={cn(HEADER, 'relative border-b border-sidebar-border px-3')}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 rounded-md border border-sidebar-border bg-background px-2.5 py-2 text-left text-sm transition-colors hover:bg-sidebar-accent"
      >
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Bot className="h-4 w-4" />
        </div>
        <span className="min-w-0 flex-1 truncate font-medium">Acme Bot</span>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className="absolute inset-x-3 top-full z-20 mt-1 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md">
          {['Acme Bot', 'Billing Helper', 'Docs Assistant'].map((name) => (
            <button
              key={name}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-muted/60"
            >
              <Bot className="h-4 w-4 text-muted-foreground" />
              {name}
            </button>
          ))}
          <button
            type="button"
            className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-sm text-muted-foreground hover:bg-muted/60"
          >
            <Plus className="h-4 w-4" />
            New agent
          </button>
        </div>
      ) : null}
    </div>
  )
}

function SubNav({
  area,
  selected,
  onSelect,
}: {
  area: AreaConfig
  selected: string
  onSelect: (id: string) => void
}) {
  const groups: { label: string | null; items: NavItem[] }[] = []
  for (const item of area.items) {
    const label = item.group ?? null
    const last = groups[groups.length - 1]
    if (last && last.label === label) {
      last.items.push(item)
    } else {
      groups.push({ label, items: [item] })
    }
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto p-2">
        {groups.map((group, index) => (
          <div key={group.label ?? `group-${index}`} className={cn(index > 0 && 'mt-3')}>
            {group.label ? (
              <p className="px-3 pb-1 pt-1 text-[11px] font-medium uppercase tracking-[0.14em] text-sidebar-foreground/50">
                {group.label}
              </p>
            ) : null}
            <div className="space-y-0.5">
              {group.items.map((item) => (
                <SubNavRow key={item.id} item={item} active={selected === item.id} onSelect={onSelect} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {area.footer ? (
        <div className="border-t border-sidebar-border p-2">
          <SubNavRow item={area.footer} active={selected === area.footer.id} onSelect={onSelect} />
        </div>
      ) : null}
    </>
  )
}

function SubNavRow({
  item,
  active,
  onSelect,
}: {
  item: NavItem
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
        active
          ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
          : item.danger
            ? 'text-destructive/80 hover:bg-destructive/10 hover:text-destructive'
            : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
      )}
    >
      <item.icon
        className={cn(
          'h-4 w-4 shrink-0',
          active ? 'text-secondary' : item.danger ? 'text-destructive/70' : 'text-sidebar-foreground/60',
        )}
      />
      <span className="min-w-0 flex-1 truncate text-left">{item.label}</span>
      {item.status ? (
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            item.status === 'on' ? 'bg-emerald-500' : 'bg-sidebar-foreground/25',
          )}
          title={item.status === 'on' ? 'On' : 'Off'}
        />
      ) : null}
    </button>
  )
}

function ContentPane() {
  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-4">
        <p className="text-sm text-muted-foreground">
          Prototype content area — the existing settings cards for this item render here unchanged.
        </p>
        <div className="space-y-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="rounded-2xl border border-border bg-card/95 p-5 shadow-sm">
              <div className="h-4 w-40 rounded bg-muted" />
              <div className="mt-3 h-3 w-full rounded bg-muted/60" />
              <div className="mt-2 h-3 w-2/3 rounded bg-muted/60" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
