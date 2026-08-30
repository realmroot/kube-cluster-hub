import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

const required = {
  HUB_PUBLIC_URL: 'https://hub.example.test',
  OIDC_CLIENT_ID: 'shared-kubernetes-client',
  OIDC_ISSUER: 'https://id.example.test',
  HUB_CLIENT_ID: 'hub-machine-client',
  HUB_CLIENT_SECRET: 'secret',
}

describe('configuration', () => {
  it('loads the five required product settings', () => {
    const config = loadConfig(required)

    expect(config).toMatchObject({
      publicUrl: 'https://hub.example.test',
      apiUrl: 'https://hub.example.test/api',
      oidcClientId: 'shared-kubernetes-client',
      oidcIssuer: 'https://id.example.test',
      hubClientId: 'hub-machine-client',
      hubClientSecret: 'secret',
      inventory: { enabled: false, kubeconfig: '', kubeconfigFile: '' },
    })
  })

  it('fails fast when a required setting is missing', () => {
    expect(() => loadConfig({ ...required, OIDC_ISSUER: '' })).toThrow(
      'OIDC_ISSUER is required',
    )
  })

  it('enables the optional Inventory projection explicitly', () => {
    const config = loadConfig({
      ...required,
      INVENTORY_ENABLED: 'true',
      INVENTORY_KUBECONFIG_FILE: '/run/secrets/inventory.kubeconfig',
    })

    expect(config.inventory).toEqual({
      enabled: true,
      kubeconfig: '',
      kubeconfigFile: '/run/secrets/inventory.kubeconfig',
    })
  })
})
