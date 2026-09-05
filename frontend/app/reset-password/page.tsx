import type { Metadata } from 'next'

import { ResetPasswordScreen } from '@/components/auth/reset-password-screen'

export const metadata: Metadata = {
  title: 'Reset password',
}

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; email?: string }>
}) {
  const params = await searchParams

  return <ResetPasswordScreen token={params.token} email={params.email} />
}
