import type { SqliteRemoteDatabase } from 'drizzle-orm/sqlite-proxy'
import type { schema } from './schema'
import type { HubStore } from './store'

export type HubDatabase = SqliteRemoteDatabase<typeof schema>

export interface DatabaseAdapter {
  readonly orm?: HubDatabase
  createStore?(): HubStore
}
