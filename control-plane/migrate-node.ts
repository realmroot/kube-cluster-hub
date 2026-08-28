import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NodeDatabaseAdapter } from './database-node'

export function migrateNodeDatabase(database: NodeDatabaseAdapter): void {
  const migrationsDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../migrations',
  )
  database.raw.exec(
    'CREATE TABLE IF NOT EXISTS hub_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  )
  const applied = new Set(
    (
      database.raw.prepare('SELECT name FROM hub_migrations').all() as Array<{
        name: string
      }>
    ).map((row) => row.name),
  )
  const files = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  for (const name of files) {
    if (applied.has(name)) continue
    if (name === '0002_clean_schema.sql') migrateLegacyRows(database)
    const migration = readFileSync(resolve(migrationsDirectory, name), 'utf8')
    database.raw.transaction(() => {
      database.raw.exec(migration)
      database.raw
        .prepare('INSERT INTO hub_migrations (name, applied_at) VALUES (?, ?)')
        .run(name, new Date().toISOString())
    })()
  }
}

function migrateLegacyRows(database: NodeDatabaseAdapter): void {
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
    UPDATE clusters SET access_mode = 'direct'
      WHERE connector_id = '' AND connector_url = '' AND ca_bundle = '';
    UPDATE clusters SET enabled = 0, inventory_status = 'migration-required',
      inventory_error = 'Configure a cluster-local Connector before re-enabling this cluster'
      WHERE connector_id = '' AND connector_url = '' AND ca_bundle <> '';
    UPDATE audit_events SET status = 499 WHERE status = 0;
  `)
}
