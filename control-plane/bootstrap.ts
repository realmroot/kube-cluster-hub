import { type AppDependencies, createApp } from './app'
import { AgentVerifier, discoverIssuer, UserVerifier } from './auth'
import type { Config, ConfigSource } from './config'
import { loadConfig } from './config'
import type { Database } from './database'
import { DispatchSigner } from './dispatch'
import { InventoryPublisher } from './inventory'
import { Store } from './store'

export interface IdentityRuntime {
  userIssuer: Awaited<ReturnType<typeof discoverIssuer>>
  agentIssuer: Awaited<ReturnType<typeof discoverIssuer>>
  signer: DispatchSigner
}

export interface Runtime {
  config: Config
  store: Store
  inventory: InventoryPublisher
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
    signer: await DispatchSigner.create(config),
  }
}

export async function bootstrap(
  database: Database,
  source: ConfigSource,
  fetcher = fetch,
  preparedIdentity?: IdentityRuntime,
): Promise<Runtime> {
  const config = loadConfig(source)
  const store = new Store(database)
  const identity = preparedIdentity ?? (await prepareIdentity(config))
  const proxy = { signer: identity.signer, fetch: fetcher }
  const inventory = new InventoryPublisher(config, store, proxy)
  const dependencies: AppDependencies = {
    config,
    store,
    users: new UserVerifier(
      identity.userIssuer,
      config.oidcAudience,
      config.oidcGroupsClaim,
    ),
    agents: new AgentVerifier(
      identity.agentIssuer,
      config.resourceUrl,
      config.resourceAuthorizedClients,
      config.resourceSigningAlgorithms,
      store,
    ),
    proxy,
    inventory,
  }
  const app = createApp(dependencies)
  return { config, store, inventory, app, dependencies }
}
