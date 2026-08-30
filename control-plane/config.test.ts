import { describe, expect, it } from 'vitest'
import { clusterEndpointAllowed, loadConfig } from './config'

const required = {
  HUB_PUBLIC_URL: 'https://hub.example.test',
  HUB_UI_CLIENT_ID: 'shared-kubernetes-client',
  OIDC_ISSUER: 'https://id.example.test',
  CATALOG_ADMIN_GROUPS: 'platform-admins',
  RESOURCE_SERVER_AUTHORIZED_CLIENT_IDS: 'toolbox-client',
  TOKEN_EXCHANGE_CLIENT_ID: 'token-exchange-client',
  TOKEN_EXCHANGE_CLIENT_SECRET: 'secret',
}

describe('configuration', () => {
  it('uses the public UI client as the Kubernetes audience by default', () => {
    const config = loadConfig(required)

    expect(config.oidcAudience).toBe('shared-kubernetes-client')
  })

  it('allows a separate Kubernetes audience as an explicit override', () => {
    const config = loadConfig({
      ...required,
      KUBERNETES_OIDC_AUDIENCE: 'dedicated-kubernetes-client',
    })

    expect(config.oidcAudience).toBe('dedicated-kubernetes-client')
  })

  it('enforces exact HTTPS origins when an endpoint allowlist is configured', () => {
    const config = loadConfig({
      ...required,
      CLUSTER_ENDPOINT_ALLOWLIST: 'https://api.example.test:6443',
    })

    expect(
      clusterEndpointAllowed(config, 'https://api.example.test:6443'),
    ).toBe(true)
    expect(clusterEndpointAllowed(config, 'https://other.example.test')).toBe(
      false,
    )
    expect(() =>
      loadConfig({
        ...required,
        CLUSTER_ENDPOINT_ALLOWLIST: 'http://api.example.test:6443',
      }),
    ).toThrow('must be HTTPS origins')
  })
})
