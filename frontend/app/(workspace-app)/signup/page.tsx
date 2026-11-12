import { AuthRoutePage } from '@/components/auth/auth-route-page'

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>
}) {
  const { returnTo } = await searchParams
  return <AuthRoutePage mode="register" returnTo={returnTo} />
}
