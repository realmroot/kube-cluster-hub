import {
  Activity,
  Boxes,
  CloudCog,
  GitBranch,
  LogOut,
  Server,
} from 'lucide-react'
import { useMemo } from 'react'
import { Navigate, NavLink, Route, Routes } from 'react-router-dom'
import { AuditPage } from './features/audit/audit-page'
import { ClustersPage } from './features/clusters/clusters-page'
import { HubApi } from './shared/api'
import { useAuth } from './shared/auth'
import type { UiConfig } from './shared/contracts'

export function App({ config }: { config: UiConfig }) {
  const auth = useAuth()
  const api = useMemo(
    () => (auth.user ? new HubApi(config, auth.user.access_token) : null),
    [auth.user, config],
  )
  if (auth.loading)
    return (
      <div className="boot">
        <Brand />
        <div className="loader" />
        <span>Restoring secure session…</span>
      </div>
    )
  if (!auth.user || !api)
    return <SignIn error={auth.error} login={auth.login} />
  return (
    <div className="shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Primary">
          <NavLink to="/clusters">
            <Server size={18} />
            Clusters
          </NavLink>
          <NavLink to="/audit">
            <Activity size={18} />
            Access audit
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          <a
            href="https://github.com/realmroot/kube-cluster-hub"
            target="_blank"
            rel="noreferrer"
          >
            <GitBranch size={17} />
            Documentation
          </a>
          <button type="button" onClick={auth.logout}>
            <LogOut size={17} />
            Sign out
          </button>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="environment">
            <span className="live-dot" />
            Control plane online
          </div>
          <div className="identity">
            <span>
              {String(
                auth.user.profile.name ||
                  auth.user.profile.email ||
                  auth.user.profile.sub,
              )}
            </span>
            <span className="avatar">
              {String(auth.user.profile.name || auth.user.profile.email || 'U')
                .slice(0, 1)
                .toUpperCase()}
            </span>
          </div>
        </header>
        <main>
          <Routes>
            <Route path="/clusters" element={<ClustersPage api={api} />} />
            <Route path="/audit" element={<AuditPage api={api} />} />
            <Route path="*" element={<Navigate to="/clusters" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  )
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Boxes size={21} />
      </span>
      <span>
        <b>Kube Cluster Hub</b>
        <small>Kubernetes access plane</small>
      </span>
    </div>
  )
}
function SignIn({ error, login }: { error: string; login(): Promise<void> }) {
  return (
    <main className="sign-in">
      <div className="sign-in-grid">
        <section>
          <Brand />
          <span className="eyebrow">Kubernetes-native by design</span>
          <h1>
            One access boundary.
            <br />
            Every cluster.
          </h1>
          <p>
            Connect dashboards and agents without storing cluster-admin
            kubeconfigs or creating a second authorization model.
          </p>
          <ul>
            <li>
              <CloudCog />
              Use your existing cluster network path
            </li>
            <li>
              <Server />
              Native Kubernetes API and RBAC
            </li>
            <li>
              <Activity />
              User and agent-attributed audit trail
            </li>
          </ul>
        </section>
        <section className="login-card">
          <span className="brand-mark large">
            <Boxes />
          </span>
          <h2>Sign in to the control plane</h2>
          <p>
            Your OpenID Provider authenticates you. Resource Server scopes
            protect catalog and audit operations.
          </p>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          <button
            type="button"
            className="button primary full"
            onClick={() => void login()}
          >
            Continue with OpenID Connect
          </button>
          <small>Authorization Code with PKCE · No client secret</small>
        </section>
      </div>
    </main>
  )
}
