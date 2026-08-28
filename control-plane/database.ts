export type SQLValue = string | number | null

export interface SQLStatement {
  sql: string
  values?: readonly SQLValue[]
}

export interface SQLResult {
  changes: number
  lastRowId?: number
}

export interface Database {
  first<T>(sql: string, values?: readonly SQLValue[]): Promise<T | undefined>
  all<T>(sql: string, values?: readonly SQLValue[]): Promise<T[]>
  run(sql: string, values?: readonly SQLValue[]): Promise<SQLResult>
  batch(statements: readonly SQLStatement[]): Promise<SQLResult[]>
}
