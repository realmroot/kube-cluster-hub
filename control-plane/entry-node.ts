import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { bootstrap } from './bootstrap'
import { NodeDatabaseAdapter } from './database-node'
import { migrateNodeDatabase } from './migrate-node'
import { attachNodeUpgradeHandler } from './upgrade-node'

const database = new NodeDatabaseAdapter(
  process.env.HUB_DATABASE_DSN || 'kube-cluster-hub.db',
)
migrateNodeDatabase(database)
const runtime = await bootstrap(database, process.env)

await runtime.inventory.reconcile()
await runtime.store.pruneAudit(
  new Date(Date.now() - runtime.config.auditRetentionMs),
)

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

const reconciliation = setInterval(
  () => {
    void runtime.inventory.reconcile().catch((error: unknown) => {
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

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(reconciliation)
    clearInterval(retention)
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
    })
  })
}
