import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './app'
import { AuthProvider } from './shared/auth'
import { type UiConfig, uiConfigSchema } from './shared/contracts'
import './pagination.css'
import './styles.css'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
})

function Root() {
  const [config, setConfig] = useState<UiConfig | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    fetch('/api/ui-config')
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            `Configuration request failed with ${response.status}`,
          )
        setConfig(uiConfigSchema.parse(await response.json()))
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : 'Configuration unavailable',
        ),
      )
  }, [])
  if (error)
    return (
      <main className="boot error">
        <h1>Control plane unavailable</h1>
        <p>{error}</p>
        <button
          type="button"
          className="button secondary"
          onClick={() => location.reload()}
        >
          Retry
        </button>
      </main>
    )
  if (!config)
    return (
      <div className="boot">
        <div className="loader" />
        <span>Loading control plane…</span>
      </div>
    )
  return (
    <AuthProvider config={config}>
      <BrowserRouter>
        <App config={config} />
      </BrowserRouter>
    </AuthProvider>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('root element is missing')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  </StrictMode>,
)
