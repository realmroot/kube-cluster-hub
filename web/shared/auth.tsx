import { type User, UserManager, WebStorageStateStore } from 'oidc-client-ts'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { UiConfig } from './contracts'

interface AuthValue {
  user: User | null
  loading: boolean
  error: string
  login(): Promise<void>
  logout(): Promise<void>
}

const AuthContext = createContext<AuthValue | undefined>(undefined)

export function AuthProvider({
  config,
  children,
}: {
  config: UiConfig
  children: ReactNode
}) {
  const manager = useMemo(
    () =>
      new UserManager({
        authority: config.issuer,
        client_id: config.clientId,
        redirect_uri: `${location.origin}/auth/callback`,
        post_logout_redirect_uri: `${location.origin}/`,
        response_type: 'code',
        scope: config.scopes.join(' '),
        extraQueryParams: { resource: config.resource },
        extraTokenParams: { resource: config.resource },
        stateStore: new WebStorageStateStore({ store: sessionStorage }),
        userStore: new WebStorageStateStore({ store: sessionStorage }),
        automaticSilentRenew: false,
        monitorSession: false,
      }),
    [config],
  )
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    async function restore() {
      try {
        const current =
          location.pathname === '/auth/callback'
            ? await manager.signinRedirectCallback()
            : await manager.getUser()
        if (location.pathname === '/auth/callback')
          history.replaceState({}, '', '/')
        if (active) setUser(current?.expired ? null : current)
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : 'Sign-in failed')
      } finally {
        if (active) setLoading(false)
      }
    }
    void restore()
    return () => {
      active = false
    }
  }, [manager])

  const value = useMemo<AuthValue>(
    () => ({
      user,
      loading,
      error,
      login: () => manager.signinRedirect(),
      logout: async () => {
        if (user?.id_token)
          await manager.signoutRedirect({ id_token_hint: user.id_token })
        else {
          await manager.removeUser()
          setUser(null)
        }
      },
    }),
    [error, loading, manager, user],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
