import { bootstrap, type IdentityRuntime, prepareIdentity } from './bootstrap'
import { auditRetentionMs, type ConfigSource, loadConfig } from './config'
import { D1DatabaseAdapter } from './database-d1'
import { isFrontendNavigation, serveFrontend } from './frontend'
import { WorkerInventoryKubernetesClient } from './inventory-worker'

type WorkerEnv = Cloudflare.Env & ConfigSource

let identityCache:
  | { fingerprint: string; promise: Promise<IdentityRuntime> }
  | undefined

function identityFor(
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<IdentityRuntime> {
  const config = loadConfig(env)
  const fingerprint = `${config.oidcIssuer}\u0000${config.uiClientId}`
  if (!identityCache || identityCache.fingerprint !== fingerprint) {
    const promise = prepareIdentity(config)
    identityCache = { fingerprint, promise }
    ctx.waitUntil(promise.then(() => undefined))
  }
  return identityCache.promise
}

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const identity = await identityFor(env, ctx)
      const runtime = await bootstrap(
        new D1DatabaseAdapter(env.DB),
        env,
        (input, init) => fetch(input, init),
        identity,
        loadConfig(env).inventory.enabled
          ? WorkerInventoryKubernetesClient.fromConfig(loadConfig(env))
          : undefined,
      )
      const response = await runtime.app.fetch(request, env, ctx)
      if (response.status === 404 && isFrontendNavigation(request)) {
        return withSecurityHeaders(await serveFrontend(request, env.ASSETS))
      }
      return withSecurityHeaders(response)
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'worker.bootstrap.error',
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      return Response.json(
        {
          type: 'about:blank',
          title: 'Service unavailable',
          status: 503,
          detail: 'Control plane configuration is unavailable',
        },
        {
          status: 503,
          headers: { 'Content-Type': 'application/problem+json' },
        },
      )
    }
  },

  async scheduled(
    _event: ScheduledController,
    env: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const identity = await identityFor(env, ctx)
    const runtime = await bootstrap(
      new D1DatabaseAdapter(env.DB),
      env,
      (input, init) => fetch(input, init),
      identity,
      loadConfig(env).inventory.enabled
        ? WorkerInventoryKubernetesClient.fromConfig(loadConfig(env))
        : undefined,
    )
    await runtime.dependencies.inventory?.reconcile()
    await runtime.store.pruneAudit(new Date(Date.now() - auditRetentionMs))
  },
} satisfies ExportedHandler<WorkerEnv>

export function withSecurityHeaders(response: Response): Response {
  if (response.status === 101) return response
  const secured = new Response(response.body, response)
  secured.headers.set('X-Content-Type-Options', 'nosniff')
  secured.headers.set('Referrer-Policy', 'no-referrer')
  secured.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  )
  secured.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  secured.headers.set(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' https:; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https:",
  )
  return secured
}
