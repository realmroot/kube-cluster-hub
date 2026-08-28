import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { NodeDatabaseAdapter } from './database-node'

export function migrateNodeDatabase(database: NodeDatabaseAdapter): void {
  const migration = readFileSync(
    fileURLToPath(
      new URL('../migrations/0001_control_plane.sql', import.meta.url),
    ),
    'utf8',
  )
  database.raw.exec(migration)
  const columns = new Set(
    (
      database.raw.prepare('PRAGMA table_info(clusters)').all() as Array<{
        name: string
      }>
    ).map((column) => column.name),
  )
  const additions = [
    ['access_mode', "TEXT NOT NULL DEFAULT 'connector'"],
    ['connector_id', "TEXT NOT NULL DEFAULT ''"],
    ['connector_url', "TEXT NOT NULL DEFAULT ''"],
  ] as const
  for (const [name, definition] of additions) {
    if (!columns.has(name))
      database.raw.exec(`ALTER TABLE clusters ADD COLUMN ${name} ${definition}`)
  }
  database.raw.exec(`
    UPDATE clusters
      SET access_mode = 'direct'
      WHERE connector_id = '' AND connector_url = '' AND ca_bundle = '';
    UPDATE clusters
      SET enabled = 0,
          inventory_status = 'migration-required',
          inventory_error = 'Configure a cluster-local Connector before re-enabling this cluster'
      WHERE connector_id = '' AND connector_url = '' AND ca_bundle <> '';
    UPDATE audit_events SET status = 499 WHERE status = 0;
  `)
}
