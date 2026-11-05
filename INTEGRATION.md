# Integration guide

## 1. Context

- Add ShieldTX to your existing Privy login and trading UI. Keep your charts, order book and normal Hyperliquid flow; use the helpers below for shielded trades.
- **Privy co-ownership model:** users own their wallets; Avail is an additional signer for trading and reshielding. You own and manage the policies; Avail manages wallet prewarming and recipient sets within those policies. This is delegated signing, not a two-party approval for every trade. See [Privy owners and signers](https://docs.privy.io/controls/authorization-keys/owners/overview).
- Other models explored: fully server-managed setup gives Avail policy administration too; user-managed setup requires user approval for provisioning/refill. This guide uses partner-managed policies with Avail-operated execution.

> **Note:** A compromise of Privy credentials on either your side or ours can affect users and funds. This integration requires a server app secret with write/full access for wallet creation and signing; a read-only secret cannot support it.

## 2. Initial Privy setup

### App and permissions

1. Use your existing [Privy app](https://dashboard.privy.io/), or create an empty app for testing. Enable your login methods, embedded Ethereum wallets and embedded Solana wallets. The user's embedded Solana address is their Nightshade (NS) root. See [React/Next.js setup](https://docs.privy.io/basics/react/setup).
2. Add your exact frontend origins in Privy and send them to Avail for coordinator CORS configuration, including `http://127.0.0.1:3000` for local testing.
3. Obtain the app ID, ES256 verification public key and a dedicated [full-access app secret](https://docs.privy.io/basics/get-started/dashboard/app-secrets) for this integration.
4. Register three distinct P-256 authorization keys/quorums: **policy admin** on your server, **trading signer** on Avail's coordinator, and **recipient-set manager** on Avail's coordinator. A quorum is a permission record, not a funded wallet. See [authorization keys and owners](https://docs.privy.io/controls/authorization-keys/owners/overview).
5. Agree the network, vault, USDC address and optional builder address/fee with Avail. Keep these identical on your onboarding server and the coordinator.

### Policy template JSON

1. Use the supplied [position policy JSON](https://github.com/availproject/example-shieldtx-integration-next/blob/main/server/policy-template.json). It covers HL actions, return from HL, USDC approval to the vault and shielding to the relay set; the optional builder rule pins the agreed recipient and fee.
2. Create the shared Ethereum Agent policy using the template's `allow-hyperliquid-l1-action` rule, owned by your policy-admin quorum. Set `source` to `b` for HL testnet or `a` for mainnet. Create the shared Solana relay policy under the same admin owner:

```json
{
  "version": "1.0",
  "name": "shieldtx-relay",
  "chain_type": "solana",
  "owner_id": "<your-policy-admin-quorum-id>",
  "rules": [{"name": "allow-relay-signing", "method": "signMessage", "action": "ALLOW", "conditions": []}]
}
```

3. Add the partner-owned [onboarding route](https://github.com/availproject/example-shieldtx-integration-next/blob/main/app/api/profile/route.ts) and [provisioning helper](https://github.com/availproject/example-shieldtx-integration-next/blob/main/server/provision.ts) to your server. On first setup, they create two recipient sets and the user's position policy from the fixed JSON. The helper fills `__POLICY_OWNER__`, `__POSITION_SET__`, `__RELAY_SET__`, network, vault, USDC and builder placeholders; it returns only `{policyId, positionSetId, relaySetId}`.
4. **Keep policy administration on your server.** Set every policy's `owner_id` to your admin quorum and retain its private key yourself. The onboarding route accepts only the authenticated user's `nsAddress`; do not accept policy JSON, rules, owners or replacement IDs from the UI, or expose a generic policy create/edit endpoint. The coordinator verifies the approved rules and prevents later replacement of bound profiles. See [policy creation and ownership](https://docs.privy.io/controls/policies/create-a-policy).
5. The write app secret can still create Privy resources, including new policies; protected policy ownership prevents editing existing policies without your admin authorization. Recipient sets remain mutable by Avail, and the relay policy permits message signing. This setup does not provide complete isolation from a server compromise.

### Secret sharing with Avail

- Share through an agreed secret manager: `PRIVY_APP_SECRET`, trading `PRIVY_AUTHZ_PRIVATE_KEY_PEM`, and `PRIVY_SET_MANAGER_KEY_PEM`. These are server credentials; never place them in browser configuration or source control.
- Supply the public configuration: app ID, verification public key, trading/admin/set-manager quorum IDs, shared Agent/relay policy IDs, frontend origins and agreed network/builder settings.
- Keep `PRIVY_POLICY_ADMIN_KEY_PEM` on **your server only**. Configure `APP_ORIGIN` and durable profile storage there; the example uses private Vercel Blob via `BLOB_READ_WRITE_TOKEN`, or you can implement `ProfileStore` with your database.
- Browser configuration contains only `NEXT_PUBLIC_PRIVY_APP_ID` and `NEXT_PUBLIC_SHIELDTX_API_URL`. Use the [partner environment template](https://github.com/availproject/example-shieldtx-integration-next/blob/main/.env.example) for the complete server settings.

## 3. Flows in steps

### Prewarming wallets

1. Log in with Privy. `useShieldTx()` resolves the user's embedded Solana root and current binding.
2. Call `client.setup(2, requestId)` with a stable UUID. On first setup, the helper calls your `POST /api/profile`, then sends the returned public IDs to the coordinator's `POST /setup`.
3. The coordinator verifies wallet ownership and the approved policy, creates empty position/relay wallets, updates the recipient sets, then publishes usable wallets through `/account`.
4. Wait for `setupReady: true` and wallets with `status: "available"` and `revocationState: "active"`. Background refill checks every 30 seconds; the current target is 2 slots, with a lifetime cap of 20 pairs. Prewarming moves no funds.
5. Retry the same request ID and count after a timeout. A pending creation requiring reconciliation must be resolved before starting another batch.

### Opening

1. Call `client.deposit(amountUsdc, ethereumWallet)`. The helper switches to the configured Arbitrum chain, approves USDC if needed and calls the vault's `shield()` function. Deposit is a contract call, not a coordinator API.
2. Wait for `client.balance()` to show spendable NS notes. A confirmed deposit receipt alone is insufficient. Use `client.estimate(order)` for margin plus funding headroom.
3. Call `client.open({clientOrderId, pair, direction, marginUsdc, leverage, tpPx, slPx})`. Use a stable UUID for `clientOrderId`; amounts/prices are decimal strings. Current entries are isolated IOC orders with required take-profit and stop-loss.
4. The helper selects an available wallet, reads notes and asks the user's NS root to sign the funding intent. It submits that intent and the order to `/open`; Avail handles solver funding and HL execution.
5. Track `client.snapshot()` until the trade is open or failed. An accepted request is not a filled position. After a timeout, reuse the same order ID and identical order; check the existing trade before starting a new one.

### Closing and reshield

1. Call `client.close(tradeId)` for a full close, or an eligible funded cancellation.
2. The coordinator closes the position and handles the return path through HL withdrawal, bridging where required, vault shielding and relay forwarding to the user's NS root.
3. Poll `client.snapshot()` for trade status and `reshieldStage`. Position closure and returned spendable balance are separate milestones.
4. If reshield needs resuming, call `client.reshield(tradeId)`. Confirm the returned funds with `client.balance()`.

## 4. APIs and helpers

- **Example repository:** [example-shieldtx-integration-next](https://github.com/availproject/example-shieldtx-integration-next). It contains a Next.js frontend, the partner-owned onboarding route, policy JSON and tests.
- **Coordinator base:** `https://<coordinator-origin>/api/shieldtx`. Every route below requires `Authorization: Bearer <Privy access token>`; POST bodies use JSON. Avail configures your Privy app first. The verified token identifies the partner and user; there is no partner slug, API-key exchange or browser-supplied user ID.
- **API contract:** [API reference](https://github.com/availproject/example-shieldtx-integration-next/blob/main/API.md), [request/response schemas](https://github.com/availproject/example-shieldtx-integration-next/blob/main/src/schema.ts) and the [coordinator route implementation](https://github.com/availproject/nightshade/blob/abhk/partner-api-poc/venue/hyperliquid_coordinator/src/partners/api.rs).

| Method | Route | Use |
| --- | --- | --- |
| GET | `/config` | Network, vault, fees, warmup limits and execution gate |
| GET | `/account` | User root, setup readiness, wallets, trades and refill cap |
| POST | `/setup` | Bind the approved profile and prewarm empty wallets |
| POST | `/read` | Root-scoped NS limits, challenge, auth token and note reads |
| POST | `/open` | Submit the user-signed funding intent and order |
| POST | `/close` | Full close or eligible funded cancellation |
| POST | `/reshield` | Request/resume return of proceeds |

- Copy [src/useShieldTx.ts](https://github.com/availproject/example-shieldtx-integration-next/blob/main/src/useShieldTx.ts), [src/client.ts](https://github.com/availproject/example-shieldtx-integration-next/blob/main/src/client.ts), [src/crypto.ts](https://github.com/availproject/example-shieldtx-integration-next/blob/main/src/crypto.ts) and [src/schema.ts](https://github.com/availproject/example-shieldtx-integration-next/blob/main/src/schema.ts), retaining their imports. They handle Privy sessions, note reads/encoding, signing, deposits, API calls and validation. Use the dependency versions in the example's `package.json`.
- Keep the [onboarding handler](https://github.com/availproject/example-shieldtx-integration-next/blob/main/server/profile.ts), provisioning helper, store and policy JSON on your server. `/api/profile` is your endpoint; it is separate from Avail's coordinator routes and is only used for onboarding.
- Keep market data on your existing HL connection. Route shielded Open/Close through the helpers.

## 5. Deployed testing

### Canary

- Demo: [stratium-shieldtx-poc.vercel.app](https://stratium-shieldtx-poc.vercel.app). Coordinator: [coordinator-canary.shieldtx.xyz](https://coordinator-canary.shieldtx.xyz). API base: `https://coordinator-canary.shieldtx.xyz/api/shieldtx`.
- Canary uses **Arbitrum mainnet, chain ID `42161`, and HL mainnet**. Vault: `0x73f228D55C8700693dabD82CF8c3D5b45F866967`; USDC: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`. A canary label does not mean testnet.
- The registered demo app is `cmvhlf47601rh0gl8c7k6pvde`, with `executionEnabled: false`, warm target 2 and wallet-pair cap 20. The demo gates deposits/Open; the coordinator rejects new Open requests while execution is disabled. Do not deposit funds for setup testing.
- **Readback on 5 November 2026:** demo HTTP 200; coordinator pod ready and `/health` healthy. Public `/api/shieldtx/config` and its browser preflight returned HTTP 404, so the partner API path must be resolved before onboarding can be verified. A funded open → close → reshield round trip is not verified.
- The deployed demo is the existing frontend. The standalone Next.js example is a separate local handoff; it has not replaced that deployment.

### Empty testnet setup

1. Start with an empty Privy test app and the standalone example. Copy `.env.example` to `.env.local`; set your public app ID/API URL and partner-server credentials. Run `bun install --frozen-lockfile --ignore-scripts`, `bun test` and `bun run dev`.
2. Ask Avail to register that app and origin against a matching **testnet** coordinator, sequencer, solver and vault. Use Arbitrum Sepolia `421614`, HL testnet, the supplied testnet vault and USDC `0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d`. The canary mainnet URL is not this testnet stack.
3. Create the three quorums and shared policies above. The optional `sandbox:bootstrap` / `sandbox:profile` scripts support isolated testnet operator setup only; see the example README. No testnet endpoint or funded deployment is provisioned by this guide.
4. With execution disabled, test login, profile creation, prewarming, retrying the same setup ID and account reads. Confirm foreign users/apps cannot access the account or replace its profile, and runtime credentials cannot edit protected policies.
5. For a funded test, Avail must enable execution and connect the matching solver callback first. Use only test USDC and test gas, then verify deposit → spendable notes → open fill → close → reshield → returned spendable balance.
