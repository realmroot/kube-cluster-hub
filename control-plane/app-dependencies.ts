import type { Hono } from 'hono'
import type { ProxyDependencies } from '../data-plane/proxy'
import type { AgentVerifier, UserVerifier } from './auth'
import type { Config } from './config'
import type { InventoryPublisher } from './inventory'
import type { HubStore } from './store'
import type { AgentTokenExchanger } from './token-exchange'

export interface Variables {
  requestId: string
}

export type HubApp = Hono<{ Variables: Variables }>

export interface AppDependencies {
  config: Config
  store: HubStore
  catalogUsers: Pick<UserVerifier, 'verify'>
  kubernetesUsers: Pick<UserVerifier, 'verify'>
  agents: Pick<AgentVerifier, 'verify'>
  agentTokens: Pick<AgentTokenExchanger, 'exchange'>
  proxy: ProxyDependencies
  isReady?(): boolean
  inventory?: Pick<InventoryPublisher, 'publish' | 'remove' | 'reconcile'>
}
