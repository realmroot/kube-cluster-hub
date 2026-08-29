import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bootstrap } from './bootstrap'
import { loadConfig } from './config'
import type { DatabaseAdapter } from './database'
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
    process.env.HUB_DATABASE_DSN || 'kube-cluster-hub.db',
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
const runtime = await bootstrap(
  database,
  process.env,
  fetch,
  undefined,
  inventoryClient,
)

await runtime.store.pruneAudit(
  new Date(Date.now() - runtime.config.auditRetentionMs),
)
await runtime.dependencies.inventory?.reconcile()

const port = Number(process.env.PORT || process.env.HUB_PORT || '8080')
const nodeApp = new Hono()
nodeApp.use('/assets/*', serveStatic({ root: './dist/client' }))
for (const path of ['/', '/auth/callback', '/clusters', '/audit']) {
  nodeApp.get(path, serveStatic({ root: './dist/client', path: 'index.html' }))
}
nodeApp.route('/', runtime.app)
const server = serve({ fetch: nodeApp.fetch, port })
attachNodeUpgradeHandler(server as import('node:http').Server, runtime)
console.log(
  JSON.stringify({ message: 'control-plane.started', runtime: 'node', port }),
)

const retention = setInterval(
  () => {
    void runtime.store
      .pruneAudit(new Date(Date.now() - runtime.config.auditRetentionMs))
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(retention)
    if (inventoryReconciliation) clearInterval(inventoryReconciliation)
    server.close((error) => {
      if (error) {
        console.error(
          JSON.stringify({
            message: 'control-plane.shutdown.error',
            error: error.message,
          }),
        )
        process.exitCode = 1
      }
      void closeDatabase().catch((closeError: unknown) => {
        console.error(
          JSON.stringify({
            message: 'database.shutdown.error',
            error:
              closeError instanceof Error
                ? closeError.message
                : String(closeError),
          }),
        )
        process.exitCode = 1
      })
    })
  })
}
