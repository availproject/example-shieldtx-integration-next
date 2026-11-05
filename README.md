# ShieldTX integration example — Next.js

Add ShieldTX to an existing Privy app: prewarm empty wallets, deposit USDC, open, close and reshield. The browser calls Avail's coordinator directly. Your Next.js server manages the approved policies during onboarding.

- [Integration guide](INTEGRATION.md): Privy setup, policy JSON, credential handoff, flows and deployed testing.
- [API reference](API.md): coordinator routes and helper inputs.
- [Frontend helpers](src/client.ts), [Privy hook](src/useShieldTx.ts), [schemas](src/schema.ts) and [signing/encoding](src/crypto.ts).
- [Partner onboarding route](app/api/profile/route.ts), [provisioning](server/provision.ts), [durable storage](server/store.ts) and [policy JSON](server/policy-template.json).

## Run locally

Use Node.js 20.9+ and Bun. Avail must register your Privy app and frontend origin before coordinator calls can succeed.

```sh
bun install --frozen-lockfile --ignore-scripts
cp .env.example .env.local
# Fill .env.local using the integration guide.
bun test
bun run build
bun run dev
```

Open http://127.0.0.1:3000. Set only public app ID/API URL under `NEXT_PUBLIC_*`; keep app secrets and authorization private keys on servers. Next.js uses `.env.local` locally. Development mode saves private onboarding checkpoints under `.data/profiles/` with conditional writes; no Blob token is needed locally. In deployment, configure the partner server's secrets and private Vercel Blob store, or replace `ProfileStore` with your database adapter.

The default environment template describes an empty testnet setup. Current canary uses mainnet and has execution disabled; its deployed API path currently returns 404. See the guide before connecting to it. This repository has not replaced the existing canary frontend deployment.

## Optional operator sandbox

These scripts create real Privy resources in a dedicated test app. They reject mainnet and never submit trades or fund wallets. Keep generated files local.

```sh
cp .env.coordinator.example .env
# Fill matching test Privy app credentials, network and vault settings.
bun run sandbox:bootstrap
bun run sandbox:profile <privy-did> <embedded-solana-address>
```

Bootstrap keeps the policy-admin private key in `.env.operator`; `.env` contains coordinator runtime settings. Provisioning saves checkpoints under `.data/`. The Next.js onboarding server needs the admin key in its server environment; never transfer it to Avail's coordinator. Copy only the required partner settings to `.env.local`, and use identical builder/network settings on both servers.

The coordinator and protocol services are operated by Avail and are not bundled here. There are no monorepo-relative Cargo commands. API/provider tests use mocks; a funded end-to-end trade is not verified by those tests.
