import type { Hono } from 'hono'
import type { AgentVerifier, UserVerifier } from './auth'
import type { Config } from './config'
import type { ProxyDependencies } from './dispatch'
import type { InventoryPublisher } from './inventory'
import type { Store } from './store'

export interface Variables {
  requestId: string
}

export type HubApp = Hono<{ Variables: Variables }>

export interface AppDependencies {
  config: Config
  store: Store
  catalogUsers: Pick<UserVerifier, 'verify'>
  kubernetesUsers: Pick<UserVerifier, 'verify'>
  agents: Pick<AgentVerifier, 'verify'>
  proxy: ProxyDependencies
  inventory: Pick<InventoryPublisher, 'publishWithStatus' | 'delete'>
}
