import { type AppDependencies, createApp } from './app'
import { AgentVerifier, discoverIssuer, UserVerifier } from './auth'
import type { Config, ConfigSource } from './config'
import { loadConfig } from './config'
import type { DatabaseAdapter } from './database'
import type { InventoryKubernetesClient } from './inventory'
import { InventoryPublisher } from './inventory'
import { type HubStore, Store } from './store'
import { AgentTokenExchanger } from './token-exchange'

export interface IdentityRuntime {
  issuer: Awaited<ReturnType<typeof discoverIssuer>>
}

export interface Runtime {
  config: Config
  store: HubStore
  app: ReturnType<typeof createApp>
  dependencies: AppDependencies
}

export async function prepareIdentity(
  config: Config,
): Promise<IdentityRuntime> {
  return { issuer: await discoverIssuer(config.oidcIssuer) }
}

export async function bootstrap(
  database: DatabaseAdapter,
  source: ConfigSource,
  fetcher = fetch,
  preparedIdentity?: IdentityRuntime,
  inventoryClient?: InventoryKubernetesClient,
): Promise<Runtime> {
  const config = loadConfig(source)
  const store = database.createStore?.() ?? new Store(requiredOrm(database))
  const identity = preparedIdentity ?? (await prepareIdentity(config))
  const proxy = { fetch: fetcher }
  const dependencies: AppDependencies = {
    config,
    store,
    catalogUsers: new UserVerifier(
      identity.issuer,
      config.apiUrl,
      config.oidcGroupsClaim,
      'access',
    ),
    kubernetesUsers: new UserVerifier(
      identity.issuer,
      config.oidcAudience,
      config.oidcGroupsClaim,
      'id',
    ),
    agents: new AgentVerifier(
      identity.issuer,
      config.apiUrl,
      config.agentAuthorizedClients,
      config.agentSigningAlgorithms,
      store,
    ),
    agentTokens: new AgentTokenExchanger(
      identity.issuer,
      config.tokenExchangeClientId,
      config.tokenExchangeClientSecret,
      config.oidcAudience,
      fetcher,
    ),
    proxy,
    ...(inventoryClient
      ? { inventory: new InventoryPublisher(config, store, inventoryClient) }
      : {}),
  }
  const app = createApp(dependencies)
  return { config, store, app, dependencies }
}

function requiredOrm(database: DatabaseAdapter) {
  if (!database.orm) throw new Error('database adapter does not expose an ORM')
  return database.orm
}
