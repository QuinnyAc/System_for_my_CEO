# Collector web routes

`/collector/*` is served by Next.js route handlers and forwarded to the collector sub-application embedded in the main API process at `API_INTERNAL_URL/collector/*`.

Do not reintroduce a direct dependency from the web container to the standalone `collector:8200` service for browser-facing collector traffic.
