import type { Database, SQLResult, SQLStatement, SQLValue } from './database'

export class D1DatabaseAdapter implements Database {
  constructor(private readonly database: D1Database) {}

  async first<T>(
    sql: string,
    values: readonly SQLValue[] = [],
  ): Promise<T | undefined> {
    const row = await this.database
      .prepare(sql)
      .bind(...values)
      .first<T>()
    return row ?? undefined
  }

  async all<T>(sql: string, values: readonly SQLValue[] = []): Promise<T[]> {
    const result = await this.database
      .prepare(sql)
      .bind(...values)
      .all<T>()
    return result.results
  }

  async run(sql: string, values: readonly SQLValue[] = []): Promise<SQLResult> {
    const result = await this.database
      .prepare(sql)
      .bind(...values)
      .run()
    return { changes: result.meta.changes, lastRowId: result.meta.last_row_id }
  }

  async batch(statements: readonly SQLStatement[]): Promise<SQLResult[]> {
    const prepared = statements.map((statement) =>
      this.database.prepare(statement.sql).bind(...(statement.values ?? [])),
    )
    const results = await this.database.batch(prepared)
    return results.map((result) => ({
      changes: result.meta.changes,
      lastRowId: result.meta.last_row_id,
    }))
  }
}
