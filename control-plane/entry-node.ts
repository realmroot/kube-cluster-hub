import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import type { Variables } from './app-dependencies'
import { bootstrap } from './bootstrap'
import { auditRetentionMs, loadConfig } from './config'
import type { DatabaseAdapter } from './database'
import { isFrontendNavigation } from './frontend'
import { hubNotFound } from './http'
import { attachNodeUpgradeHandler } from './upgrade-node'

const databaseUrl = process.env.HUB_DATABASE_URL?.trim()
let database: DatabaseAdapter
let closeDatabase: () => Promise<void>
if (databaseUrl) {
  const { PostgresDatabaseAdapter } = await import('./database-postgres')
  const postgres = new PostgresDatabaseAdapter(databaseUrl)
  await postgres.migrate()
  database = postgres
  closeDatabase = () => postgres.close()
} else {
  const [{ NodeDatabaseAdapter }, { migrateNodeDatabase }] = await Promise.all([
    import('./database-node'),
    import('./migrate-node'),
  ])
  const sqlite = new NodeDatabaseAdapter(
    process.env.HUB_SQLITE_PATH?.trim() || 'kube-cluster-hub.db',
  )
  migrateNodeDatabase(sqlite)
  database = sqlite
  closeDatabase = async () => {
    sqlite.raw.close()
  }
}
const nodeConfig = loadConfig(process.env)
const inventoryClient = nodeConfig.inventory.enabled
  ? (await import('./inventory-node')).NodeInventoryKubernetesClient.fromConfig(
      nodeConfig,
    )
  : undefined
let ready = true
const runtime = await bootstrap(
  database,
  process.env,
  fetch,
  undefined,
  inventoryClient,
  () => ready,
)

await runtime.store.pruneAudit(new Date(Date.now() - auditRetentionMs))
await runtime.dependencies.inventory?.reconcile()

const port = Number(process.env.PORT || '8080')
const nodeApp = new Hono<{ Variables: Variables }>()
nodeApp.use('/assets/*', serveStatic({ root: './dist/client' }))
nodeApp.get('*', async (context, next) => {
  if (!isFrontendNavigation(context.req.raw)) return next()
  return serveStatic({ root: './dist/client', path: 'index.html' })(
    context,
    next,
  )
})
nodeApp.route('/', runtime.app)
nodeApp.notFound(hubNotFound)
const server = serve({ fetch: nodeApp.fetch, port })
const upgradeLifecycle = attachNodeUpgradeHandler(
  server as import('node:http').Server,
  runtime,
)
console.log(
  JSON.stringify({ message: 'control-plane.started', runtime: 'node', port }),
)

const retention = setInterval(
  () => {
    void runtime.store
      .pruneAudit(new Date(Date.now() - auditRetentionMs))
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({
            message: 'audit.retention.error',
            error: error instanceof Error ? error.message : String(error),
          }),
        )
      })
  },
  24 * 60 * 60 * 1_000,
)
const inventoryReconciliation = runtime.dependencies.inventory
  ? setInterval(
      () => {
        void runtime.dependencies.inventory
          ?.reconcile()
          .catch((error: unknown) => {
            console.error(
              JSON.stringify({
                message: 'inventory.reconcile.error',
                error: error instanceof Error ? error.message : String(error),
              }),
            )
          })
      },
      5 * 60 * 1_000,
    )
  : undefined

let shutdownStarted = false
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => void shutdown(signal))

async function shutdown(signal: 'SIGINT' | 'SIGTERM'): Promise<void> {
  if (shutdownStarted) return
  shutdownStarted = true
  ready = false
  clearInterval(retention)
  if (inventoryReconciliation) clearInterval(inventoryReconciliation)
  console.log(
    JSON.stringify({ message: 'control-plane.shutdown.started', signal }),
  )
  const deadlineMillis = 25_000
  let deadline: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.all([
        closeHttpServer(server as import('node:http').Server),
        upgradeLifecycle.close(5_000),
      ]).then(() => closeDatabase()),
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error('shutdown deadline exceeded')),
          deadlineMillis,
        )
        deadline.unref()
      }),
    ])
    console.log(JSON.stringify({ message: 'control-plane.shutdown.completed' }))
  } catch (error) {
    process.exitCode = 1
    console.error(
      JSON.stringify({
        message: 'control-plane.shutdown.error',
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  } finally {
    if (deadline) clearTimeout(deadline)
  }
}

function closeHttpServer(server: import('node:http').Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
    server.closeIdleConnections()
  })
}
