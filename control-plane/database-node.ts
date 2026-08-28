import DatabaseDriver from 'better-sqlite3'
import type { Database, SQLResult, SQLStatement, SQLValue } from './database'

export class NodeDatabaseAdapter implements Database {
  readonly raw: DatabaseDriver.Database

  constructor(filename: string) {
    this.raw = new DatabaseDriver(filename)
    this.raw.pragma('journal_mode = WAL')
    this.raw.pragma('foreign_keys = ON')
  }

  async first<T>(
    sql: string,
    values: readonly SQLValue[] = [],
  ): Promise<T | undefined> {
    return this.raw.prepare(sql).get(...values) as T | undefined
  }

  async all<T>(sql: string, values: readonly SQLValue[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...values) as T[]
  }

  async run(sql: string, values: readonly SQLValue[] = []): Promise<SQLResult> {
    const result = this.raw.prepare(sql).run(...values)
    return {
      changes: result.changes,
      lastRowId: Number(result.lastInsertRowid),
    }
  }

  async batch(statements: readonly SQLStatement[]): Promise<SQLResult[]> {
    return this.raw.transaction(() =>
      statements.map((statement) => {
        const result = this.raw
          .prepare(statement.sql)
          .run(...(statement.values ?? []))
        return {
          changes: result.changes,
          lastRowId: Number(result.lastInsertRowid),
        }
      }),
    )()
  }
}
