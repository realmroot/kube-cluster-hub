declare namespace Cloudflare {
  interface Env {
    DB: D1Database
    ASSETS: Fetcher
  }

  interface GlobalProps {
    mainModule: typeof import('./entry-worker')
  }
}
