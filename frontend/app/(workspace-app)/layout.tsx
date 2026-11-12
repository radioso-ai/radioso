import { SunriseProvider } from '@/components/auth/sunrise'
import { AuthProvider } from '@/lib/auth-context'
import { WorkspaceProvider } from '@/lib/workspace-context'

// The operator's session: sign-in, the dashboard, and the account pages. Visitor surfaces —
// the website embed and public chat links — stay outside this group. They run on customer
// sites, often in a third-party frame where reading storage throws, and have no operator
// session to restore.
export default function WorkspaceAppLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <SunriseProvider>
      <AuthProvider>
        <WorkspaceProvider>
          {children}
        </WorkspaceProvider>
      </AuthProvider>
    </SunriseProvider>
  )
}
