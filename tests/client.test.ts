import { expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { z } from "zod";
import { createShieldTxClient } from "../src/client";
import { hex, intentHash, noteCommitment, type Intent } from "../src/crypto";
import { bytes, noteSchema, type Order } from "../src/schema";
const seed = new Uint8Array(32).fill(51);
const root = ed25519.getPublicKey(seed);
const config = {
  appId: "test-app", isTestnet: true, chainId: 421614, vault: "0x" + "11".repeat(20), executionEnabled: true,
  usdc: "0x" + "02".repeat(20), solverPublicKey: "0x" + "07".repeat(32), solverAddress: "0x" + "03".repeat(20),
  builder: { b: "0x" + "11".repeat(20), f: 10 },
};
const note = { owner: { Key: { bytes: Array.from(root) } }, amount: "10000000", asset: new Array(20).fill(2), nonce: new Array(32).fill(4) };
const order: Order = { clientOrderId: "10000000-0000-4000-8000-000000000001", pair: "ETH-USD", direction: "long", marginUsdc: "5", leverage: 2, tpPx: "4200", slPx: "3000" };
const tradeId = "10000000-0000-4000-8000-000000000002";
function harness(options: { loseResponse?: boolean; wrongSigner?: boolean; wrongOwner?: boolean; amount?: string; duplicate?: boolean; disabled?: boolean } = {}) {
  const opens: unknown[] = []; const methods: string[] = []; let signatures = 0;
  const client = createShieldTxClient({
    nsAddress: bs58.encode(root), getAccessToken: async () => "test-token",
    signBytes: async message => { signatures++; return ed25519.sign(message, options.wrongSigner ? new Uint8Array(32).fill(7) : seed); },
    fetch: async (url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
      const path = String(url).replace("/api/shieldtx", "");
      if (path === "/config") return Response.json({ ...config, executionEnabled: !options.disabled });
      if (path === "/account") return Response.json({
        wallets: [false, true].map(relay => ({ address: "0x" + (relay ? "44" : "09").repeat(20), relay, status: "available", phase: null, nsPublicKey: null, revocationState: "active" })), trades: [], builder: config.builder,
      });
      const body: unknown = JSON.parse(String(init?.body));
      if (path === "/read") {
        const { method, params } = z.object({ method: z.string(), params: z.array(z.record(z.string(), z.unknown())) }).parse(body);
        methods.push(method);
        const result = method === "getChallenge" ? new Array(32).fill(7)
          : method === "getAuthToken" ? new Array(32).fill(8)
          : method === "getLimits" ? { max_num_input_notes: 64, max_num_output_notes: 64 }
          : params[0]?.starting_index === 0 ? [options.wrongOwner ? { ...note, owner: { Key: { bytes: new Array(32).fill(9) } } } : { ...note, amount: options.amount ?? note.amount }, ...(options.duplicate ? [note] : [])] : [];
        return Response.json({ result });
      }
      if (path === "/open") {
        opens.push(body);
        if (options.loseResponse && opens.length === 1) throw new Error("Simulated response loss after submission");
        return Response.json({ tradeId, replay: opens.length > 1 }, { status: 202 });
      }
      throw new Error("Unexpected route: " + path);
    },
  });
  return { client, opens, methods, signatures: () => signatures };
}
test("browser note/intent bytes match Rust canonical fixtures", () => {
  expect(hex(noteCommitment(noteSchema.parse(note)))).toBe("0xa9687805d24487a1ba91d425d83f0233ed2629e091177e7039420e14fb4c46d2");
  const intent: Intent = { escrowed_amount: "0xf4240", solver: { bytes: new Array(32).fill(7) }, timeout_blocks: 500,
    resolution: { Attested: { destination_chain: 42161, recipient_address: new Array(20).fill(9), expected_amount: "0xf4240", expected_asset: new Array(20).fill(2), expected_sender: new Array(20).fill(3) } } };
  expect(hex(intentHash([new Array(32).fill(17), new Array(32).fill(34)], intent))).toBe("0xf752702cc7c4b763bae3a65bd6ed7ddf7095b725a255a031590046a6a69aa9d3");
});
test("open builds, signs and submits the exact funded wallet binding; retry is byte-identical", async () => {
  const h = harness({ loseResponse: true });
  await expect(h.client.open(order)).rejects.toThrow("Simulated response loss");
  expect(await h.client.open(order)).toEqual({ tradeId, replay: true });
  expect(h.opens).toHaveLength(2); expect(h.opens[1]).toEqual(h.opens[0]); expect(h.signatures()).toBe(2);
  const body = z.object({
    fundingAmountMicroUsdc: z.string(), dexPositionAccount: z.string(), nsOwnerAccount: z.string(),
    sequencerSignedIntent: z.object({ signature: z.object({ bytes: bytes(64) }), input_commitments: z.array(bytes(32)), payload: z.object({ CreateIntent: z.unknown() }) }),
  }).parse(h.opens[0]);
  expect(body.fundingAmountMicroUsdc).toBe("6107000");
  expect(body.nsOwnerAccount).toBe(hex(root)); expect(body.dexPositionAccount).toBe("0x" + "09".repeat(20));
  const intent = body.sequencerSignedIntent.payload.CreateIntent as Intent;
  expect(ed25519.verify(Uint8Array.from(body.sequencerSignedIntent.signature.bytes), intentHash(body.sequencerSignedIntent.input_commitments, intent), root)).toBe(true);
  await expect(h.client.open({ ...order, leverage: 3 })).rejects.toThrow("different order");
});
test("wrong signer, foreign notes, insufficient funding, and duplicate notes cannot open", async () => {
  for (const [options, message] of [
    [{ wrongSigner: true }, "signature"], [{ wrongOwner: true }, "Wrong-owner"],
    [{ amount: "1" }, "Deposit first"], [{ duplicate: true }, "Duplicate notes"],
  ] as const) {
    const h = harness(options); await expect(h.client.open(order)).rejects.toThrow(message); expect(h.opens).toHaveLength(0);
  }
});
test("invalid order is rejected before reads or signing", async () => {
  const h = harness();
  await expect(h.client.open({ ...order, marginUsdc: "1.0000001" })).rejects.toThrow();
  expect(h.methods).toHaveLength(0); expect(h.signatures()).toBe(0);
});
test("setup-only mode rejects financial operations before signing or submission", async () => {
  const h = harness({ disabled: true });
  await expect(h.client.open(order)).rejects.toThrow("execution is disabled");
  expect(h.methods).toHaveLength(0); expect(h.signatures()).toBe(0); expect(h.opens).toHaveLength(0);
});
test("first setup obtains a partner-protected profile; ready refills go directly to Rust", async () => {
  const profile = { policyId: "p".repeat(24), positionSetId: "s".repeat(24), relaySetId: "r".repeat(24) };
  let ready = false, profiles = 0;
  const setups: unknown[] = [];
  const client = createShieldTxClient({
    nsAddress: bs58.encode(root), getAccessToken: async () => "test-token",
    signBytes: async () => { throw new Error("Setup must not sign funding intents"); },
    getProfile: async () => { profiles++; return profile; },
    fetch: async (url, init) => {
      if (String(url).endsWith("/account")) return Response.json({ wallets: [], trades: [], builder: null, setupReady: ready });
      if (String(url).endsWith("/setup")) {
        setups.push(JSON.parse(String(init?.body))); ready = true;
        return Response.json({ ready: true });
      }
      throw new Error("Unexpected route");
    },
  });
  const requestId = crypto.randomUUID();
  await client.setup(2, requestId);
  expect(setups[0]).toEqual({ nsAddress: bs58.encode(root), walletCount: 2, requestId, profile });
  await client.setup(1, crypto.randomUUID());
  expect(profiles).toBe(1);
  expect(setups[1]).not.toHaveProperty("profile");
});
