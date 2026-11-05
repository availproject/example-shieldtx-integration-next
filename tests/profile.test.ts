import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { generateKeyPair, exportSPKI, SignJWT } from "jose";
import { handleProfile } from "../server/profile";
import { ProfileError, type ProfileLedger, type ProfileStore, type Fetcher } from "../server/provision";

const nsAddress = "CZ8YUVdk7znjrUmnb5n7kgySk9yRAsQDYmyCxzfSky9t";
const did = "did:privy:user";
const admin = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const tokenKey = await generateKeyPair("ES256");
const env = {
  APP_ORIGIN: "https://demo.example", PRIVY_APP_ID: "test-app", PRIVY_APP_SECRET: "fake-app-secret",
  PRIVY_VERIFICATION_KEY: await exportSPKI(tokenKey.publicKey),
  PRIVY_POLICY_ADMIN_KEY_PEM: admin.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  PRIVY_POLICY_ADMIN_QUORUM_ID: "a".repeat(24), PRIVY_SET_MANAGER_QUORUM_ID: "m".repeat(24),
  PRIVY_AUTHZ_KEY_ID: "r".repeat(24), IS_TESTNET: "false", HL_SIGNATURE_CHAIN_ID: "42161",
  VAULT_ADDRESS: "0x" + "22".repeat(20), HL_BUILDER_ADDRESS: "0x" + "ab".repeat(20), HL_BUILDER_FEE_TENTHS_BPS: "10",
};
async function jwt(claims: Record<string, unknown> = {}, algorithm = "ES256") {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: did, aud: env.PRIVY_APP_ID, iss: "privy.io", iat: now, exp: now + 60, ...claims };
  return new SignJWT(payload).setProtectedHeader({ alg: algorithm }).sign(tokenKey.privateKey);
}
function harness(options: { foreignRoot?: boolean; loseCreate?: boolean; rejectAdmin?: boolean; concurrentLoads?: boolean; rejectFirstCreate?: boolean } = {}) {
  let saved: ProfileLedger | undefined;
  const creates: { path: string; body: Record<string, unknown> }[] = [];
  let calls = 0;
  // This models the blob store's per-request compare-and-swap snapshot.
  let revision = 0;
  let loads = 0, release!: () => void;
  const bothLoaded = new Promise<void>(resolve => { release = resolve; });
  const store = (): ProfileStore => {
    let expected = 0;
    return {
      async load() {
        expected = revision;
        const snapshot = structuredClone(saved);
        if (options.concurrentLoads) { if (++loads === 2) release(); await bothLoaded; }
        return snapshot;
      },
      async save(state) {
        if (expected !== revision) throw new ProfileError("PROFILE_BUSY", 409, "Concurrent update");
        saved = structuredClone(state); expected = ++revision;
      },
    };
  };
  const fetcher: Fetcher = async (url, init) => {
    calls++;
    expect(new URL(String(url)).origin).toBe("https://api.privy.io");
    expect(init?.redirect).toBe("error");
    const path = new URL(String(url)).pathname;
    if (path.startsWith("/v1/users/")) return Response.json({ id: did, linked_accounts: [{
      type: "wallet", chain_type: "solana", wallet_client_type: "privy", address: options.foreignRoot ? "foreign" : nsAddress,
    }] });
    if (path.startsWith("/v1/key_quorums/")) return Response.json({ authorization_threshold: 1, authorization_keys: [{
      public_key: options.rejectAdmin ? "wrong" : admin.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    }] });
    if (init?.method === "POST") {
      creates.push({ path, body: JSON.parse(String(init.body)) });
      if (options.rejectFirstCreate && creates.length === 1) return new Response(null, { status: 429 });
      if (options.loseCreate) throw new Error("Lost provider response with sensitive request data");
      return Response.json({ id: String(creates.length).padStart(24, "x") });
    }
    throw new Error("Unexpected provider request");
  };
  return { store, fetcher, creates, calls: () => calls, saved: () => saved };
}
function request(token: string, body: unknown = { nsAddress }, origin = env.APP_ORIGIN) {
  return new Request(env.APP_ORIGIN + "/api/profile", {
    method: "POST", headers: { authorization: "Bearer " + token, origin }, body: JSON.stringify(body),
  });
}

test("profile authenticates, creates mainnet-pinned C resources once, and returns public IDs only", async () => {
  const h = harness(), token = await jwt();
  const run = () => handleProfile(request(token), { env, store: h.store(), fetcher: h.fetcher });
  const first = await run();
  expect(first.status).toBe(200);
  expect(first.headers.get("cache-control")).toBe("no-store");
  const result = await first.json();
  expect(Object.keys(result).sort()).toEqual(["policyId", "positionSetId", "relaySetId"]);
  expect(h.creates).toHaveLength(3);
  expect(h.creates.slice(0, 2).every(c => c.body.owner_id === env.PRIVY_SET_MANAGER_QUORUM_ID)).toBe(true);
  const policy = h.creates[2]!.body;
  expect(policy.owner_id).toBe(env.PRIVY_POLICY_ADMIN_QUORUM_ID);
  const serialized = JSON.stringify(policy);
  for (const value of ["42161", "Mainnet", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "0.01%", env.VAULT_ADDRESS])
    expect(serialized).toContain(value);
  const rules = policy.rules as { name: string; conditions: { field: string; value: string }[] }[];
  expect(rules.find(r => r.name === "allow-hyperliquid-l1-action")!.conditions.find(c => c.field === "source")!.value).toBe("a");
  expect(rules.find(r => r.name === "allow-hyperliquid-send-to-evm")!.conditions.find(c => c.field === "chainId")!.value).toBe("42161");
  // HL's canonical builder approval domain stays 421614 on both networks.
  expect(rules.find(r => r.name === "allow-pinned-builder-approval")!.conditions.find(c => c.field === "chainId")!.value).toBe("421614");
  expect(serialized).not.toContain("__");
  expect(await (await run()).json()).toEqual(result);
  expect(h.creates).toHaveLength(3);
  const checkpoint = JSON.stringify(h.saved());
  expect(checkpoint).not.toContain(token);
  expect(checkpoint).not.toContain("PRIVATE KEY");
  expect(checkpoint).not.toContain(env.PRIVY_APP_SECRET);
});

test("invalid, expired, cross-app, future-issued and array-audience tokens never call Privy", async () => {
  const now = Math.floor(Date.now() / 1000);
  const tokens = ["not-a-token", await jwt({ aud: "other-app" }), await jwt({ exp: now - 1 }),
    await jwt({ iat: now + 100 }), await jwt({ iss: "other" }), await jwt({ sub: "not-a-did" }),
    await jwt({ aud: [env.PRIVY_APP_ID, "other-app"] })];
  for (const token of tokens) {
    const h = harness();
    expect((await handleProfile(request(token), { env, store: h.store(), fetcher: h.fetcher })).status).toBe(401);
    expect(h.calls()).toBe(0);
  }
});

test("foreign origins, invalid input and unknown fields cannot create resources", async () => {
  const token = await jwt();
  for (const [body, origin, expected] of [
    [{ nsAddress }, "https://evil.example", 403], [{ nsAddress, did: "did:privy:other" }, env.APP_ORIGIN, 400],
    [{ nsAddress: "0".repeat(40) }, env.APP_ORIGIN, 400], [{ nsAddress: "1".repeat(32) }, env.APP_ORIGIN, 400],
    [{ nsAddress: "x".repeat(3000) }, env.APP_ORIGIN, 413],
  ] as const) {
    const h = harness();
    expect((await handleProfile(request(token, body, origin), { env, store: h.store(), fetcher: h.fetcher })).status).toBe(expected);
    expect(h.calls()).toBe(0);
  }
});

test("foreign roots and wrong admin keys cannot provision", async () => {
  for (const [options, status] of [[{ foreignRoot: true }, 403], [{ rejectAdmin: true }, 503]] as const) {
    const h = harness(options);
    expect((await handleProfile(request(await jwt()), { env, store: h.store(), fetcher: h.fetcher })).status).toBe(status);
    expect(h.creates).toHaveLength(0);
  }
});

test("unknown provider creation is fenced across requests without exposing provider errors", async () => {
  const h = harness({ loseCreate: true }), token = await jwt();
  const first = await handleProfile(request(token), { env, store: h.store(), fetcher: h.fetcher });
  expect(first.status).toBe(503);
  expect(await first.text()).not.toContain("sensitive request data");
  expect(h.saved()?.pending).toBe("positionSet");
  const second = await handleProfile(request(token), { env, store: h.store(), fetcher: h.fetcher });
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ error: { code: "PROFILE_PENDING", retryable: false } });
  expect(h.creates).toHaveLength(1);
});

test("a definitive Privy rate-limit rejection can retry without a permanent pending fence", async () => {
  const h = harness({ rejectFirstCreate: true }), token = await jwt();
  const run = () => handleProfile(request(token), { env, store: h.store(), fetcher: h.fetcher });
  const first = await run();
  expect(first.status).toBe(503);
  expect(await first.json()).toMatchObject({ error: { code: "PRIVY_RATE_LIMITED", retryable: true } });
  expect(h.saved()?.pending).toBeUndefined();
  expect((await run()).status).toBe(200);
  expect(h.creates).toHaveLength(4);
});

test("concurrent first setup cannot create duplicate resources", async () => {
  const h = harness({ concurrentLoads: true }), token = await jwt();
  const responses = await Promise.all([0, 1].map(() => handleProfile(request(token), { env, store: h.store(), fetcher: h.fetcher })));
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect(h.creates).toHaveLength(3);
});

test("a stored profile cannot be rebound to another root and network mismatch fails before writes", async () => {
  const h = harness(), token = await jwt();
  expect((await handleProfile(request(token), { env, store: h.store(), fetcher: h.fetcher })).status).toBe(200);
  expect((await handleProfile(request(token, { nsAddress: "So11111111111111111111111111111111111111112" }), { env, store: h.store(), fetcher: h.fetcher })).status).toBe(409);
  const other = harness();
  expect((await handleProfile(request(token), { env: { ...env, HL_SIGNATURE_CHAIN_ID: "421614" }, store: other.store(), fetcher: other.fetcher })).status).toBe(503);
  expect(other.calls()).toBe(0);
  expect(h.creates).toHaveLength(3);
});
