import { type AppDependencies, createApp } from './app'
import { AgentVerifier, discoverIssuer, UserVerifier } from './auth'
import type { Config, ConfigSource } from './config'
import { loadConfig } from './config'
import type { DatabaseAdapter } from './database'
import { type HubStore, Store } from './store'

export interface IdentityRuntime {
  userIssuer: Awaited<ReturnType<typeof discoverIssuer>>
  agentIssuer: Awaited<ReturnType<typeof discoverIssuer>>
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
  const userIssuer = await discoverIssuer(config.oidcIssuer)
  const agentIssuer =
    config.resourceIssuer === config.oidcIssuer
      ? userIssuer
      : await discoverIssuer(config.resourceIssuer)
  return {
    userIssuer,
    agentIssuer,
  }
}

export async function bootstrap(
  database: DatabaseAdapter,
  source: ConfigSource,
  fetcher = fetch,
  preparedIdentity?: IdentityRuntime,
): Promise<Runtime> {
  const config = loadConfig(source)
  const store = database.createStore?.() ?? new Store(requiredOrm(database))
  const identity = preparedIdentity ?? (await prepareIdentity(config))
  const proxy = { fetch: fetcher }
  const dependencies: AppDependencies = {
    config,
    store,
    catalogUsers: new UserVerifier(
      identity.userIssuer,
      config.catalogUrl,
      config.oidcGroupsClaim,
      'access',
    ),
    kubernetesUsers: new UserVerifier(
      identity.userIssuer,
      config.oidcAudience,
      config.oidcGroupsClaim,
      'id',
    ),
    agents: new AgentVerifier(
      identity.agentIssuer,
      config.resourceUrl,
      config.resourceAuthorizedClients,
      config.resourceSigningAlgorithms,
      store,
    ),
    proxy,
  }
  const app = createApp(dependencies)
  return { config, store, app, dependencies }
}

function requiredOrm(database: DatabaseAdapter) {
  if (!database.orm) throw new Error('database adapter does not expose an ORM')
  return database.orm
}
