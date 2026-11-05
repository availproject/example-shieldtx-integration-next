# Coordinator API and helpers

Base: `https://<coordinator-origin>/api/shieldtx`. Every request requires `Authorization: Bearer <Privy access token>`. POST bodies are JSON. Your app ID and exact frontend origin must be registered with Avail first; the verified token selects the partner and user.

Use [client.ts](src/client.ts) with [useShieldTx.ts](src/useShieldTx.ts) rather than reimplementing note serialization and signatures. Runtime schemas are in [schema.ts](src/schema.ts); canonical note/intent encoding is in [crypto.ts](src/crypto.ts). The [integration guide](INTEGRATION.md) covers setup and ownership.

## Helper calls

```ts
const { client } = useShieldTx(); // inside a component under your PrivyProvider
if (!client) return;             // wait for session and NS-root binding

await client.setup(2, stableWarmupId);
await client.deposit("20", ethereumWallet);
const balance = await client.balance(); // wait for spendable notes
const order = {
  clientOrderId: stableOrderId,
  pair: "ETH-USD", direction: "long" as const,
  marginUsdc: "5", leverage: 2, tpPx: takeProfitPrice, slPx: stopLossPrice,
};
const requiredUsdc = await client.estimate(order);
const accepted = await client.open(order);
const account = await client.snapshot(); // poll actual progress
await client.close(accepted.tradeId, stableCloseId);
await client.reshield(accepted.tradeId); // only if return needs resuming
```

`estimate` returns required funding headroom as a decimal USDC string, not a fee quote. `open` takes decimal strings for margin and TP/SL prices, integer leverage 1–100, `long`/`short`, and a nonzero UUID order ID. Keep a stable setup/order/close ID across retries; after a timeout check `/account` before starting another operation. `open` caches an identical signed retry body for the lifetime of the client instance.

## HTTP contract

- `GET /config` → `200`, [Config](src/schema.ts): app ID, network/chain ID, vault, USDC, solver identity, optional builder fee, execution flag and warmup limits.
- `GET /account` → `200`, [Snapshot](src/schema.ts): `nsRoot`, `setupReady`, `wallets`, `trades`, builder, lifetime wallet-pair count and refill-cap state. Only the authenticated user's data is returned; results are bounded to 200 wallet rows and 100 recent trades.
- `POST /setup` → `200 {"ready":true,"replay":false}`. Body below. `walletCount` is 1–3 additional empty slots; first setup requires the profile from your server. Later calls can omit it, and cannot replace an existing binding.

```json
{
  "nsAddress": "<user's embedded Solana address in base58>",
  "requestId": "<nonzero UUID>",
  "walletCount": 2,
  "profile": {
    "policyId": "<24-character Privy ID>",
    "positionSetId": "<24-character Privy ID>",
    "relaySetId": "<24-character Privy ID>"
  }
}
```

- `POST /read` → `200` with the sequencer JSON-RPC envelope (`result` or `error`). Body: `{"method":"getLimits","params":[]}`. Only these methods are accepted; wallet reads must use the registered root:

| Method | `params` |
| --- | --- |
| `getLimits` | `[]` |
| `getChallenge` | `[{public_key:{bytes:Bytes32}}]` |
| `getAuthToken` | `[{public_key:{bytes:Bytes32},signature:{bytes:Bytes64}}]` |
| `getUnspentNotes` | `[{public_key:{bytes:Bytes32},auth_token:Bytes32,starting_index:integer}]` |

`Bytes32`/`Bytes64` are arrays of bytes. The helper signs the challenge, obtains the read token, paginates notes and validates ownership.

- `POST /open` → `202 {"tradeId":"<UUID>","replay":false}`. The helper converts its order input into exactly these fields: `clientOrderId`, `dexPositionAccount`, `fundingAmountMicroUsdc`, `pair`, `direction`, `leverage`, `sizeUsd`, `tpPx`, `slPx`, `nsOwnerAccount`, `sequencerReadAuthTokenHex`, `sequencerSignedIntent`. The funding amount is an integer micro-USDC string; root/read token are 32-byte hex strings. The signed intent contains `input_commitments`, `payload.CreateIntent` and `signature.bytes`, generated and verified by the helper. No browser-supplied user ID, builder fee override or extra fields are accepted. `executionEnabled: false` rejects new opens.
- `POST /close` → `202 {"tradeId":"<UUID>","replay":false}`. Body: `{"tradeId":"<UUID>","clientOrderId":"<nonzero UUID>","nsOwnerAccount":"<registered root as 32-byte hex>"}`. Full close or eligible funded cancellation.
- `POST /reshield` → `202 {"tradeId":"<UUID>"}`. Body: `{"tradeId":"<UUID>"}`. Requests/resumes the return path for an owned trade.

A successful `202` is acceptance, not completion. Read `/account` for trade stage, terminal status, failure reason and `reshieldStage`; confirm returned spendable notes with `balance()`. Deposit is an ERC-20 approval plus vault `shield()` contract call; there is no coordinator deposit endpoint.

## Errors

```json
{"error":{"code":"WALLET_UNAVAILABLE","message":"no position and relay wallet pair is available","retryable":true}}
```

- Typical boundaries: `401 UNAUTHORIZED`, `403 ORIGIN_NOT_ALLOWED / ROOT_MISMATCH`, `409 SETUP_REQUIRED / SETUP_INCOMPLETE`, `429 RATE_LIMITED`, `503 EXECUTION_DISABLED`.
- Setup may return `POLICY_SETUP_REQUIRED`, `PROFILE_ALREADY_BOUND`, `REQUEST_ID_CONFLICT` or `SETUP_RECONCILE_REQUIRED`. Resolve configuration or pending provider outcomes before creating more resources; changing the request ID does not resolve them.
- A retryable response does not guarantee success. Reuse the same operation identity and input; do not infer that a timeout means nothing happened. HTTP body-limit errors may not use the JSON envelope.

## Partner-owned onboarding endpoint

`POST /api/profile` is hosted by **your Next.js server**, not the coordinator. It accepts the same bearer token and only `{"nsAddress":"<embedded Solana address>"}`. The server verifies the app/user/root, creates the fixed approved profile once, and returns `{policyId,positionSetId,relaySetId}` with `200`.

Policy JSON, admin keys, owner selection and policy replacement are never browser inputs. The handler uses server configuration and durable, conditional checkpoints. See [route.ts](app/api/profile/route.ts), [profile.ts](server/profile.ts), [provision.ts](server/provision.ts) and [policy-template.json](server/policy-template.json).
