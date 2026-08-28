import { bootstrap, type IdentityRuntime, prepareIdentity } from './bootstrap'
import { type ConfigSource, loadConfig } from './config'
import { D1DatabaseAdapter } from './database-d1'

interface WorkerSecrets {
  GATEWAY_PUBLIC_URL: string
  GATEWAY_INVENTORY_ACCESS_URL?: string
  OIDC_ISSUER: string
  OIDC_AUDIENCE: string
  OIDC_GROUPS_CLAIM?: string
  CATALOG_ADMIN_GROUPS: string
  RESOURCE_SERVER_URL: string
  RESOURCE_SERVER_ISSUER: string
  RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS: string
  RESOURCE_SERVER_JWT_ALGORITHMS?: string
  KUBERNETES_AGENT_READ_GROUP?: string
  KUBERNETES_AGENT_WRITE_GROUP?: string
  DISPATCH_SIGNING_PRIVATE_JWK: string
  DISPATCH_ISSUER?: string
  DISPATCH_AUDIENCE?: string
  CONNECTOR_STATUS_TOKEN: string
  INVENTORY_CLUSTER_ID?: string
  AUDIT_RETENTION?: string
}

type WorkerEnv = WorkerSecrets & { DB: D1Database }

let identityCache:
  | { fingerprint: string; promise: Promise<IdentityRuntime> }
  | undefined

function identityFor(
  env: WorkerEnv,
  ctx: ExecutionContext,
): Promise<IdentityRuntime> {
  const config = loadConfig(env)
  const fingerprint = `${config.oidcIssuer}\u0000${config.resourceIssuer}\u0000${config.dispatchPrivateJwk.kid}`
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
        env satisfies ConfigSource,
        fetch,
        identity,
      )
      return await runtime.app.fetch(request, env, ctx)
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
      env satisfies ConfigSource,
      fetch,
      identity,
    )
    await runtime.inventory.reconcile()
    await runtime.store.pruneAudit(
      new Date(Date.now() - runtime.config.auditRetentionMs),
    )
  },
} satisfies ExportedHandler<WorkerEnv>
