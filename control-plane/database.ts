import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import type { schema } from './schema'

export type HubDatabase = SqliteRemoteDatabase<typeof schema>

export interface DatabaseAdapter {
  readonly orm: HubDatabase
}
