export interface AssetFetcher {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
}

export function isFrontendNavigation(request: Request): boolean {
  if (request.method !== 'GET') return false
  const path = new URL(request.url).pathname
  return ![
    '/api/',
    '/clusters/',
    '/openapi/',
    '/.well-known/',
    '/healthz',
    '/readyz',
  ].some((prefix) => path === prefix || path.startsWith(prefix))
}

export async function serveFrontend(
  request: Request,
  assets: AssetFetcher,
): Promise<Response> {
  const indexUrl = new URL('/index.html', request.url)
  return assets.fetch(indexUrl)
}
