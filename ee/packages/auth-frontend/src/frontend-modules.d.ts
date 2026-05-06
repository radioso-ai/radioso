declare module '@/components/ui/button' {
  import type { ComponentType, ReactNode } from 'react'

  export const Button: ComponentType<{
    asChild?: boolean
    className?: string
    disabled?: boolean
    onClick?: () => void
    type?: 'button' | 'submit' | 'reset'
    variant?: 'default' | 'outline'
    children?: ReactNode
  }>
}

declare module '@/components/ui/input' {
  import type { ComponentType } from 'react'

  export const Input: ComponentType<{
    disabled?: boolean
    id?: string
    onChange?: (event: { target: { value: string } }) => void
    placeholder?: string
    required?: boolean
    type?: string
    value?: string
  }>
}

declare module '@/components/ui/label' {
  import type { ComponentType, ReactNode } from 'react'

  export const Label: ComponentType<{
    htmlFor?: string
    children?: ReactNode
  }>
}

declare module '@/components/ui/spinner' {
  import type { ComponentType } from 'react'

  export const Spinner: ComponentType<{ className?: string }>
}

declare module '@/lib/api' {
  export function seedWorkspaceSession(workspaceId: string, workspacePublicRouteKey?: string | null): void
}

declare module '@/lib/auth-context' {
  export function useAuth(): {
    login(email: string, userId: string, accountId: string): Promise<void>
  }
}

declare module '@/lib/dashboard-routes' {
  export function buildDashboardHref(accountId: string, input: {
    section: string
    workspaceId?: string | null
    workspacePublicRouteKey?: string | null
  }): string
}
