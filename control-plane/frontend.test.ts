import { describe, expect, it, vi } from 'vitest'
import { isFrontendNavigation, serveFrontend } from './frontend'

describe('frontend routing', () => {
  it('serves the SPA entry point for the OIDC callback', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({ entry: true }, { status: 200 }),
    )
    const request = new Request(
      'https://hub.example.test/auth/callback?code=code&state=state',
    )

    expect(isFrontendNavigation(request)).toBe(true)
    const response = await serveFrontend(request, { fetch })

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledOnce()
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://hub.example.test/index.html',
    )
  })

  it('does not convert API misses into HTML', () => {
    expect(
      isFrontendNavigation(
        new Request('https://hub.example.test/api/catalog/missing'),
      ),
    ).toBe(false)
  })
})
