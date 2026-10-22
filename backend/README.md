# CosmosVote Backend

Off-chain notification service for CosmosVote. Polls Soroban/Horizon RPC for governance contract events and delivers them to a configured webhook.

## HTTP API and OpenAPI

This package runs a background worker and does not currently expose notification-service HTTP
routes. `WEBHOOK_URL` is an outbound destination for event delivery, not an API served by this
process. Consequently, there is no `/openapi.json` or `/docs` endpoint to document yet. Issue #42
requires an HTTP API and its request/response contracts to be defined before an OpenAPI
specification and Swagger UI can be generated.

### Subscription Management API

Issue #49's subscription list, update, and delete routes depend on that API foundation. The
notification service currently has no HTTP router, and its subscription records are not associated
with an authenticated caller. Its admin/viewer API keys identify shared roles, not individual
subscribers. Before exposing these routes, define how subscriptions belong to callers and enforce
that ownership for list, update, and delete; otherwise an authenticated caller could access another
subscriber's channel details or change their preferences. The API contract and OpenAPI document
should be added with that ownership model.

## Security Headers and HTTPS

All HTTP responses from the faucet API are passed through [`helmet`](https://helmetjs.github.io/), which sets the following headers:

| Header | Value |
|--------|-------|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin` |

### HTTPS-only enforcement

The service itself does not terminate TLS. It must be deployed behind a TLS-terminating
reverse proxy or load balancer (e.g. nginx, Caddy, or a cloud LB) that:

- serves the API only over `https://` and redirects or rejects plain `http://` requests,
- forwards the original scheme (e.g. `X-Forwarded-Proto: https`) so the app can detect HTTPS,
- keeps TLS certificates valid and renewed.

Because HSTS is sent with a one-year `max-age`, browsers that have seen the header will refuse
plain-HTTP connections to the host for that period. Only enable HSTS on hosts that are
permanently served over HTTPS; never expose the API directly over HTTP in production.

### Verifying headers

After deploying behind TLS, scan the public API URL with
[securityheaders.com](https://securityheaders.com) (e.g. `https://api.example.com`). The scan
should report a rating of **A or higher**. You can also check headers directly:

```bash
curl -sI https://api.example.com/api/faucet/claim | grep -Ei 'strict-transport|x-frame|x-content-type|referrer-policy'
```

## Error Tracking
=======

Errors are captured via [Sentry](https://sentry.io). Set `SENTRY_DSN` in your environment to enable. Without it, errors are written to `stderr` only.

### Alert Trigger Conditions

| Condition | Severity | Details |
|-----------|----------|---------|
| Unhandled exception | **Critical** | Captured automatically on process startup via `Sentry.init()` |
| Unhandled promise rejection | **Critical** | Captured automatically |
| Event polling failure | **Warning** | Captured on every failure; tagged `alertThresholdReached=true` when ≥ 3 consecutive failures occur |
| Webhook delivery failure | **Error** | Captured with webhook URL and event type |

### Setting Up Alerts in Sentry

1. Go to **Alerts → Create Alert Rule** in your Sentry project.
2. Create an issue alert for:
   - `alertThresholdReached = true` (poll failures) — notify on-call immediately.
   - Any `Critical` level event — page on-call immediately.
   - Any `Error` level event in `production` environment — notify team channel.

## Setup

```bash
cd backend
cp .env.example .env
# Edit .env
npm install
npm run build
npm start
```

## Development

```bash
npm run dev   # run with ts-node (no build needed)
npm test      # run tests
```

## Testnet Token Faucet

The optional faucet API runs separately from the notification worker:

```bash
export FAUCET_ENABLED=true
export FAUCET_ALLOWED_ORIGIN=https://your-frontend.example
export FAUCET_TOKEN_CONTRACT_ID=<testnet-token-contract-id>
export FAUCET_ADMIN_SECRET_KEY=<testnet-admin-secret>
npm run build
npm run start:faucet
```

It exposes `POST /api/faucet/claim` with `{ "address": "G..." }`. The service signs only Soroban testnet transactions, mints `FAUCET_AMOUNT` base units, and permits one claim per wallet address every 24 hours. The SQLite database at `FAUCET_DB_PATH` must be on durable storage; losing it resets cooldown records. Keep the admin key in the deployment secret manager and fund its testnet account with XLM for transaction fees. Do not expose this service with a mainnet admin key.

For local container testing, set `FAUCET_TOKEN_CONTRACT_ID` and `FAUCET_ADMIN_SECRET_KEY`, then run `docker compose --profile faucet up --build faucet`. The compose profile mounts a persistent `faucet-data` volume. Run one faucet instance against that SQLite volume; do not scale it across hosts.
