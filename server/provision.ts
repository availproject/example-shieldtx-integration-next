// Partner-controlled cold path. Never import this module into browser code.
import { createPublicKey } from "node:crypto";
import { v5 } from "uuid";
import bs58 from "bs58";
import { z } from "zod";
import { profileSchema } from "../src/schema";
import template from "./policy-template.json" with { type: "json" };

export const ledgerSchema = z.object({
  actorId: z.uuid(), nsAddress: z.string(), pending: z.string().optional(),
  resources: z.record(z.string(), z.string()),
});
export type ProfileLedger = z.infer<typeof ledgerSchema>;
export type ProfileStore = {
  load(actorId: string): Promise<unknown | undefined>;
  save(state: ProfileLedger): Promise<void>;
};
export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export class ProfileError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}
export async function provisionProfileResources(
  env: Readonly<Record<string, string>>, adminKey: string, did: string,
  nsAddress: string, store: ProfileStore, fetcher: Fetcher = fetch,
) {
  let root: Uint8Array;
  try { root = bs58.decode(nsAddress); }
  catch { throw new ProfileError("INVALID_ROOT", 400, "Invalid Solana address"); }
  if (!/^did:privy:[a-zA-Z0-9_-]{1,100}$/.test(did) || root.length !== 32 || root.every(b => b === 0))
    throw new ProfileError("INVALID_ROOT", 400, "Valid Privy DID and embedded Solana address required");
  const required = (name: string) => z.string().min(1).parse(env[name]);
  const app = required("PRIVY_APP_ID"), secret = required("PRIVY_APP_SECRET");
  const testnet = env.IS_TESTNET === "true";
  if (!["true", "false"].includes(required("IS_TESTNET")) || env.HL_SIGNATURE_CHAIN_ID !== (testnet ? "421614" : "42161"))
    throw new Error("Policy network configuration mismatch");
  const admin = required("PRIVY_POLICY_ADMIN_QUORUM_ID"), manager = required("PRIVY_SET_MANAGER_QUORUM_ID");
  const runtime = required("PRIVY_AUTHZ_KEY_ID");
  if (admin === manager || admin === runtime || manager === runtime)
    throw new Error("Separate control quorums required");
  const vault = z.string().regex(/^0x[0-9a-f]{40}$/i).refine(v => !/^0x0{40}$/i.test(v)).parse(env.VAULT_ADDRESS).toLowerCase();
  const rate = env.HL_BUILDER_ADDRESS ? z.coerce.number().int().min(1).max(100).parse(env.HL_BUILDER_FEE_TENTHS_BPS) : 0;
  if (rate) z.string().regex(/^0x[0-9a-f]{40}$/i).refine(v => !/^0x0{40}$/i.test(v)).parse(env.HL_BUILDER_ADDRESS);
  const actorId = v5(app + ":" + did, v5.URL);
  const saved = await store.load(actorId);
  const state = ledgerSchema.parse(saved ?? { actorId, nsAddress, resources: {} });
  if (state.actorId !== actorId || state.nsAddress !== nsAddress)
    throw new ProfileError("PROFILE_CONFLICT", 409, "Profile root cannot be replaced");
  if (state.pending)
    throw new ProfileError("PROFILE_PENDING", 409, "Unknown creation outcome or setup in progress; reconcile before creating more");
  async function api(
    method: string,
    route: string,
    body?: unknown,
  ): Promise<unknown> {
    const response = await fetcher("https://api.privy.io" + route, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization:
          "Basic " + Buffer.from(app + ":" + secret).toString("base64"),
        "privy-app-id": app,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      if (method === "POST" && [400, 401, 403, 404, 422, 429].includes(response.status)) {
        delete state.pending;
        await store.save(state);
        throw new ProfileError(response.status === 429 ? "PRIVY_RATE_LIMITED" : "PRIVY_REJECTED", 503,
          "Privy rejected profile creation (HTTP " + response.status + "); retry the same setup after resolving the rejection");
      }
      throw new Error(
        "Privy rejected profile request (HTTP " +
          response.status +
          "); pending creations require reconciliation",
      );
    }
    return response.json();
  }
  const user = z
    .object({
      id: z.string(),
      linked_accounts: z.array(
        z
          .object({
            type: z.string(),
            chain_type: z.string().optional(),
            wallet_client_type: z.string().optional(),
            address: z.string().optional(),
          })
          .passthrough(),
      ),
    })
    .parse(await api("GET", "/v1/users/" + did));
  if (
    user.id !== did ||
    !user.linked_accounts.some(
      (a) =>
        a.type === "wallet" &&
        a.chain_type === "solana" &&
        ["privy", "privy-v2"].includes(a.wallet_client_type ?? "") &&
        a.address === nsAddress,
    )
  )
    throw new ProfileError("ROOT_NOT_OWNED", 403, "Root is not this user's embedded wallet");
  const quorum = z
    .object({
      authorization_threshold: z.number(),
      authorization_keys: z.array(z.object({ public_key: z.string() })),
    })
    .parse(await api("GET", "/v1/key_quorums/" + admin));
  const publicKey = createPublicKey(
    z.string().min(1).parse(adminKey),
  )
    .export({ type: "spki", format: "der" })
    .toString("base64");
  if (
    quorum.authorization_threshold !== 1 ||
    !quorum.authorization_keys.some((k) => k.public_key === publicKey)
  )
    throw new Error("Operator does not control the policy-admin quorum");
  async function create(name: string, route: string, body: unknown) {
    if (state.resources[name]) return state.resources[name]!;
    state.pending = name;
    await store.save(state);
    const { id } = z
      .object({ id: z.string().regex(/^[a-zA-Z0-9]{24}$/) })
      .parse(await api("POST", route, body));
    state.resources[name] = id;
    delete state.pending;
    await store.save(state);
    return id;
  }
  const position = await create("positionSet", "/v1/condition_sets", {
    name: "shieldtx-positionSet-" + actorId,
    owner_id: manager,
  });
  const relay = await create("relaySet", "/v1/condition_sets", {
    name: "shieldtx-relaySet-" + actorId,
    owner_id: manager,
  });
  const replacements: Record<string, string> = {
    __POLICY_OWNER__: admin,
    __POSITION_SET__: position,
    __RELAY_SET__: relay,
    __VAULT__: vault,
    __USDC__: testnet ? "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d" : "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    __CHAIN__: testnet ? "421614" : "42161",
    __HL_SOURCE__: testnet ? "b" : "a",
    __HL_NETWORK__: testnet ? "Testnet" : "Mainnet",
    __BUILDER__: env.HL_BUILDER_ADDRESS?.toLowerCase() ?? "",
    __BUILDER_RATE__: (rate / 1000).toString() + "%",
  };
  function replace(value: unknown): unknown {
    if (typeof value === "string") return replacements[value] ?? value;
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, replace(v)]),
      );
    return value;
  }
  const policy = z
    .object({ rules: z.array(z.object({ name: z.string() }).passthrough()) })
    .passthrough()
    .parse(replace(template));
  policy.name = "shieldtx-" + actorId;
  if (!rate)
    policy.rules = policy.rules.filter(
      (r) => r.name !== "allow-pinned-builder-approval",
    );
  const policyId = await create("policy", "/v1/policies", policy);
  return profileSchema.parse({
    policyId,
    positionSetId: position,
    relaySetId: relay,
  });
}
