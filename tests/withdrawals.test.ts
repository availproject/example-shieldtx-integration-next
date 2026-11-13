import { expect, test } from "bun:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";
import { concatHex, keccak256, stringToHex } from "viem";
import { createShieldTxClient, ShieldTxApiError, type EthereumWallet } from "../src/client";
import { hex, noteCommitment, raw, withdrawalId } from "../src/crypto";
import { noteSchema, type Withdrawal } from "../src/schema";

const root = ed25519.getPublicKey(new Uint8Array(32).fill(51));
const config = {
  appId: "test-app", isTestnet: true, chainId: 421614, vault: "0x" + "11".repeat(20), executionEnabled: true,
  usdc: "0x" + "02".repeat(20), solverPublicKey: "0x" + "07".repeat(32), solverAddress: "0x" + "03".repeat(20), builder: null,
};
const note = noteSchema.parse({ owner: { Key: { bytes: Array.from(root) } }, amount: "10000000", asset: new Array(20).fill(2), nonce: new Array(32).fill(4) });
const nullifier = keccak256(concatHex([stringToHex("nightshade_note_nullifier_v1"), hex(noteCommitment(note)), hex(note.nonce)]));
// Shared with the coordinator (routes/withdrawals.rs) and the ShieldTX page tests.
const LEAF = "0xb88a11fd158794863469ef8f43ecefff45bf67035d2aa43bc1fb1e5ce9160bd3";
const withdrawal: Withdrawal = {
  id: LEAF, phase: "claimable", asset: config.usdc, amount: "2500000", recipient: "0x" + "07".repeat(20),
  nullifiers: [nullifier], batchNumber: 9, indexInBatch: 1,
};
const token = "0x" + "08".repeat(32);
const noWallet = new Proxy({} as EthereumWallet, { get: () => { throw new Error("wallet must not be used"); } });

function harness(routes: (path: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const client = createShieldTxClient({
    nsAddress: bs58.encode(root), getAccessToken: async () => "test-token",
    signBytes: async () => { throw new Error("withdrawal reads must not sign"); },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url) === "/api/shieldtx/config") return Response.json(config);
      // The open withdrawal relay must never receive partner credentials.
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      return routes(String(url).replace("/api/withdrawals", ""), init);
    },
  });
  return { client, calls };
}

test("withdrawal leaf matches the Rust and Vault encoding", () => {
  expect(withdrawalId(raw(config.usdc, 20), 2_500_000n, [raw(nullifier, 32)], raw(withdrawal.recipient, 20))).toBe(LEAF);
});

test("history pages with the caller's read token, keeps USDC only and lists newest first", async () => {
  const other = { ...withdrawal, id: "0x" + "aa".repeat(32), asset: "0x" + "09".repeat(20) };
  const newer = { ...withdrawal, id: "0x" + "bb".repeat(32), phase: "enqueued", batchNumber: null, indexInBatch: null };
  const bodies: unknown[] = [];
  const h = harness((path, init) => {
    expect(path).toBe("/history");
    const body = JSON.parse(String(init?.body)) as { startingIndex: number };
    bodies.push(body);
    return Response.json({ withdrawals: body.startingIndex === 0 ? [withdrawal, other] : body.startingIndex === 2 ? [newer] : [] });
  });
  expect((await h.client.withdrawals(token)).map((w) => w.id)).toEqual([newer.id, withdrawal.id]);
  expect(bodies).toEqual([0, 2, 3].map((startingIndex) => ({ publicKey: hex(root), authToken: token, startingIndex })));
});

test("an expired read token surfaces as READ_TOKEN_REJECTED", async () => {
  const h = harness(() => Response.json({ error: { code: "READ_TOKEN_REJECTED", message: "expired" } }, { status: 409 }));
  const error = await h.client.withdrawals(token).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ShieldTxApiError);
  expect((error as ShieldTxApiError).code).toBe("READ_TOKEN_REJECTED");
});

test("claim refuses unclaimable, tampered or mismatched-proof withdrawals before touching the wallet", async () => {
  const proof = (leaf: string, index = 1) => Response.json({ leaf, index, proof: ["0x" + "06".repeat(32)], root: "0x" + "05".repeat(32) });
  const cases: [Withdrawal, Response | null, string][] = [
    [{ ...withdrawal, phase: "proved" }, null, "not claimable"],
    [{ ...withdrawal, batchNumber: null }, null, "not claimable"],
    [{ ...withdrawal, amount: "2500001" }, null, "does not match its ID"],
    [{ ...withdrawal, recipient: "0x" + "08".repeat(20) }, null, "does not match its ID"],
    [withdrawal, proof("0x" + "cc".repeat(32)), "proof does not match"],
    [withdrawal, proof(LEAF, 2), "proof does not match"],
  ];
  for (const [input, response, message] of cases) {
    const h = harness((path) => {
      expect(path).toBe("/proof?batchNumber=9&indexInBatch=1");
      if (!response) throw new Error("proof must not be fetched");
      return response;
    });
    await expect(h.client.claim(input, noWallet)).rejects.toThrow(message);
  }
});
