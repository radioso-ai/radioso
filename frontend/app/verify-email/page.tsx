import type { Metadata } from 'next'

import { VerifyEmailScreen } from '@/components/auth/verify-email-screen'

export const metadata: Metadata = {
  title: 'Verify email',
}

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const params = await searchParams

  return <VerifyEmailScreen token={params.token} />
}
