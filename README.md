# ShieldTX partner integration example

A Next.js example that adds ShieldTX to an existing Privy login and trading UI.

- **[Integration guide](https://app.notion.com/p/avail-project/ShieldTX-Partner-Integration-Guide-40fe67c666dd804ab451c78cef146d69?source=copy_link)** — setup, user flows and session handling.
- **[OpenAPI specification](openapi.json)** — coordinator endpoints, authentication, schemas and errors.
- **[Frontend example](src/App.tsx)** — connection, balance polling, deposits and trading wired into a UI.

## Run locally

Use Bun and Node.js 20.9+. Register your public Privy app ID, verification public
key and frontend origin with ShieldTX, and obtain the coordinator URL.

```sh
bun install --frozen-lockfile --ignore-scripts
cp .env.example .env.local
```

Set `NEXT_PUBLIC_PRIVY_APP_ID` to your existing app ID and
`NEXT_PUBLIC_SHIELDTX_API_URL` to the supplied coordinator URL, including
`/api/shieldtx`. Both values are public frontend configuration.

```sh
bun run dev --port 3000
```

Open `http://localhost:3000` and use that exact origin in your app registration.
If your Privy app restricts allowed origins, add it under **Configuration → App
settings → Domains**. The hook discovers the hosted ShieldTX login origin through
`/config`.

## Frontend files

| File | What to use it for |
| --- | --- |
| [App.tsx](src/App.tsx) | Working button, form, polling and error-handling examples |
| [useShieldTx.ts](src/useShieldTx.ts) | `connect()`, `disconnect()`, `renewReadSession()` and the authenticated client |
| [client.ts](src/client.ts) | Account, balance, deposit, estimate, open, close and reshield calls |
| [connection.ts](src/connection.ts) | Communication with the hosted ShieldTX window |
| [schema.ts](src/schema.ts), [crypto.ts](src/crypto.ts) | Payload validation and canonical transaction encoding |

Use `useShieldTx()` inside your existing `PrivyProvider`. Call connection,
session renewal and trade opening from user actions; the example polls balances
and account state automatically. Initial wallet setup happens during connection.

Run `bun test` and `bun run typecheck` to check the example.
