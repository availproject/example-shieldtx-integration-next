// Canonical Nightshade bytes; no private keys and no TS orchestrator dependency.
import { keccak256, bytesToHex, hexToBytes } from "viem";
import type { Note } from "./schema";
const utf8 = (s: string) => new TextEncoder().encode(s);

export const hex = (bytes: number[] | Uint8Array) => bytesToHex(Uint8Array.from(bytes));

/** Decode a fixed-size hex value before it enters a signed payload. */
export function raw(value: string, size: number): Uint8Array {
  if (!new RegExp(`^0x[0-9a-f]{${size * 2}}$`, "i").test(value))
    throw new Error("Invalid byte length");
  return hexToBytes(value as `0x${string}`);
}
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
const hash = (...parts: Uint8Array[]) => hexToBytes(keccak256(concat(...parts)));
function uint(n: bigint, size: number, little = true): Uint8Array {
  if (n < 0n || n >= 1n << BigInt(size * 8)) throw new Error("Integer out of bounds");
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    out[little ? i : size - 1 - i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}
const u256 = (n: bigint) => concat(uint(32n, 8), uint(n, 32, false));

/** Match Nightshade's note commitment; changing this encoding invalidates funding signatures. */
export function noteCommitment(note: Note): number[] {
  return Array.from(
    hash(
      utf8("nightshade_note_commitment_v1"),
      Uint8Array.of(0),
      Uint8Array.from(note.owner.Key.bytes),
      uint(BigInt(note.amount), 32),
      Uint8Array.from(note.asset),
      Uint8Array.from(note.nonce),
    ),
  );
}

export type Intent = {
  escrowed_amount: string;
  solver: { bytes: number[] };
  timeout_blocks: number;
  resolution: {
    Attested: {
      destination_chain: number;
      recipient_address: number[];
      expected_amount: string;
      expected_asset: number[];
      expected_sender: number[];
    };
  };
};

/** Hash the canonical intent bytes that the ShieldTX wallet signs. */
export function intentHash(inputs: number[][], intent: Intent): Uint8Array {
  const r = intent.resolution.Attested;
  return hash(
    utf8("nightshade_transaction_intent_v1"),
    ...inputs.map((x) => Uint8Array.from(x)),
    uint(2n, 4),
    Uint8Array.from(intent.solver.bytes),
    u256(BigInt(intent.escrowed_amount)),
    uint(1n, 4),
    uint(BigInt(r.destination_chain), 8),
    Uint8Array.from(r.recipient_address),
    u256(BigInt(r.expected_amount)),
    Uint8Array.from(r.expected_asset),
    Uint8Array.from(r.expected_sender),
    uint(BigInt(intent.timeout_blocks), 8),
  );
}
