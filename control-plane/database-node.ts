import DatabaseDriver from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { DatabaseAdapter } from './database'
import { schema } from './schema'

export class NodeDatabaseAdapter implements DatabaseAdapter {
  readonly raw: DatabaseDriver.Database
  readonly orm

  constructor(filename: string) {
    this.raw = new DatabaseDriver(filename)
    this.raw.pragma('journal_mode = WAL')
    this.raw.pragma('foreign_keys = ON')
    this.orm = drizzle(
      async (sql, params, method) => ({
        rows: execute(this.raw, sql, params, method),
      }),
      async (batch) =>
        this.raw.transaction(() =>
          batch.map(({ sql, params, method }) => ({
            rows:
              method === 'get'
                ? [execute(this.raw, sql, params, method)]
                : execute(this.raw, sql, params, method),
          })),
        )(),
      { schema },
    )
  }
}

function execute(
  database: DatabaseDriver.Database,
  sql: string,
  params: unknown[],
  method: 'run' | 'all' | 'values' | 'get',
): unknown[] | unknown[][] {
  const statement = database.prepare(sql)
  if (method === 'run') {
    statement.run(...params)
    return []
  }
  if (method === 'get')
    return (statement.raw(true).get(...params) as unknown[] | undefined) ?? []
  return statement.raw(true).all(...params) as unknown[][]
}
