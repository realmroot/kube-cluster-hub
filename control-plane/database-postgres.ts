import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import type { DatabaseAdapter } from './database'
import { pgAuditEvents, pgClusters, pgDpopProofs } from './schema-postgres'
import { PostgresStore } from './store-postgres'

const schema = { pgClusters, pgDpopProofs, pgAuditEvents }

export class PostgresDatabaseAdapter implements DatabaseAdapter {
  private readonly client
  private readonly database

  constructor(url: string) {
    this.client = postgres(url, { max: 10 })
    this.database = drizzle(this.client, { schema })
  }

  createStore(): PostgresStore {
    return new PostgresStore(this.database)
  }

  async migrate(): Promise<void> {
    const directory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../migrations-postgres',
    )
    const files = (await readdir(directory))
      .filter((name) => name.endsWith('.sql'))
      .sort()
    await this.client.begin(async (transaction) => {
      await transaction`SELECT pg_advisory_xact_lock(hashtext('kube-cluster-hub-migrations'))`
      await transaction`
        CREATE TABLE IF NOT EXISTS hub_migrations (
          name TEXT PRIMARY KEY,
          applied_at TEXT NOT NULL
        )
      `
      const applied = new Set(
        (
          await transaction<{ name: string }[]>`SELECT name FROM hub_migrations`
        ).map((row) => row.name),
      )
      for (const name of files) {
        if (applied.has(name)) continue
        const migration = await readFile(resolve(directory, name), 'utf8')
        await transaction.unsafe(migration)
        await transaction`
          INSERT INTO hub_migrations (name, applied_at)
          VALUES (${name}, ${new Date().toISOString()})
        `
      }
    })
  }

  async close(): Promise<void> {
    await this.client.end()
  }
}
