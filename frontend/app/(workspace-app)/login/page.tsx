import { AuthRoutePage } from '@/components/auth/auth-route-page'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string }>
}) {
  const { returnTo } = await searchParams
  return <AuthRoutePage mode="login" returnTo={returnTo} />
}
