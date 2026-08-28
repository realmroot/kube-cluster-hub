import { drizzle } from 'drizzle-orm/sqlite-proxy'
import type { DatabaseAdapter } from './database'
import { schema } from './schema'

export class D1DatabaseAdapter implements DatabaseAdapter {
  readonly orm

  constructor(database: D1Database) {
    this.orm = drizzle(
      async (sql, params, method) => ({
        rows: await execute(database, sql, params, method),
      }),
      async (batch) => {
        const results = await database.batch(
          batch.map(({ sql, params }) => database.prepare(sql).bind(...params)),
        )
        return results.map((result) => ({
          rows: result.results.map((row) =>
            Object.values(row as Record<string, unknown>),
          ),
        }))
      },
      { schema },
    )
  }
}

async function execute(
  database: D1Database,
  sql: string,
  params: unknown[],
  method: 'run' | 'all' | 'values' | 'get',
): Promise<unknown[] | unknown[][]> {
  const statement = database.prepare(sql).bind(...params)
  if (method === 'run') {
    await statement.run()
    return []
  }
  const rows = await statement.raw()
  return method === 'get' ? (rows[0] ?? []) : rows
}
