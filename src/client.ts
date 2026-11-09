import { z } from "zod";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  createPublicClient,
  createWalletClient,
  custom,
  erc20Abi,
  formatUnits,
  parseUnits,
  type Hex,
  type Address,
} from "viem";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import {
  acceptedSchema,
  bytes,
  configSchema,
  noteSchema,
  orderSchema,
  positive,
  snapshotSchema,
  setupSchema,
  type Config,
  type Order,
} from "./schema";
import { hex, intentHash, noteCommitment, raw, type Intent } from "./crypto";

export type EthereumWallet = {
  address: string;
  switchChain: (chain: number) => Promise<void>;
  getEthereumProvider: () => Promise<{
    request: (input: { method: string; params?: unknown[] }) => Promise<unknown>;
  }>;
};
type Options = {
  baseUrl?: string;
  getAccessToken: () => Promise<string | null>;
  nsAddress: string;
  signBytes: (message: Uint8Array) => Promise<Uint8Array>;
  accountId?: string;
  hosted?: { open: (order: Order) => Promise<{ tradeId: string; replay: boolean }> };
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

/** Check code for actions such as READ_SESSION_REQUIRED instead of matching the message. */
export class ShieldTxApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ShieldTxApiError";
  }
}
const vaultAbi = [
  {
    type: "function",
    name: "shield",
    stateMutability: "payable",
    outputs: [],
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "recipient", type: "bytes32" },
      { name: "feeAmount", type: "uint256" },
    ],
  },
] as const;

/** The hook supplies partner authentication; the ShieldTX page supplies native signing. */
export function createShieldTxClient(options: Options) {
  const root = bs58.decode(options.nsAddress);
  if (root.length !== 32 || root.every((x) => x === 0)) throw new Error("Invalid Nightshade root");
  const owner = { bytes: Array.from(root) };
  const base = options.baseUrl ?? "/api/shieldtx";
  const fetcher = options.fetch ?? fetch;
  let opening = false;
  const submissions = new Map<string, { order: string; body: unknown }>();

  // Refresh the user token before each call; never configure this client with an app secret.
  async function api(path: string, body?: unknown): Promise<unknown> {
    const token = await options.getAccessToken();
    if (!token) throw new Error("Sign in first");
    const response = await fetcher(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(options.accountId ? { "x-shieldtx-account-id": options.accountId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const error = z
        .object({ error: z.object({ message: z.string(), code: z.string().optional() }) })
        .safeParse(await response.json().catch(() => null));
      throw new ShieldTxApiError(
        error.success ? error.data.error.message : `ShieldTX HTTP ${response.status}`,
        error.success ? error.data.error.code : undefined,
      );
    }
    return response.json();
  }
  let cachedConfig: Config | undefined;

  /** Load network addresses and execution settings for this integration. */
  const config = async () => (cachedConfig ??= configSchema.parse(await api("/config")));

  /** Poll for wallet readiness, trade stages and return progress. */
  const snapshot = async () => snapshotSchema.parse(await api("/account"));
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const result = z
      .object({ result: z.unknown().optional(), error: z.unknown().optional() })
      .parse(await api("/read", { method, params }));
    if (result.error !== undefined)
      throw new Error("Nightshade read failed; retry the read if its approval expired");
    if (!("result" in result)) throw new Error("Invalid Nightshade read response");
    return result.result;
  }
  async function checkedSign(message: Uint8Array): Promise<Uint8Array> {
    const signature = await options.signBytes(message);
    if (signature.length !== 64 || !ed25519.verify(signature, message, root))
      throw new Error("Privy signature does not match the Nightshade root");
    return signature;
  }

  // Native-only: authenticate a note read with the ShieldTX root, then check each returned note.
  async function notes() {
    const challenge = bytes(32).parse(await rpc("getChallenge", [{ public_key: owner }]));
    const signature = await checkedSign(Uint8Array.from(challenge));
    const token = bytes(32).parse(
      await rpc("getAuthToken", [
        { public_key: owner, signature: { bytes: Array.from(signature) } },
      ]),
    );
    const result: z.infer<typeof noteSchema>[] = [];
    for (let page = 0, offset = 0; page < 100; page++) {
      const batch = z
        .array(noteSchema)
        .parse(
          await rpc("getUnspentNotes", [
            { public_key: owner, auth_token: token, starting_index: offset },
          ]),
        );
      for (const note of batch)
        if (hex(note.owner.Key.bytes) !== hex(root))
          throw new Error("Wrong-owner note from sequencer");
      if (!batch.length) {
        const identities = result.map(noteCommitment).map(hex);
        if (new Set(identities).size !== identities.length)
          throw new Error("Duplicate notes from sequencer");
        return { notes: result, token };
      }
      result.push(...batch);
      offset += batch.length;
    }
    throw new Error("Note scan limit reached");
  }

  function funding(order: Order, cfg: Config) {
    const margin = parseUnits(order.marginUsdc, 6);
    const notional = margin * BigInt(order.leverage);
    // Native-perp IOC fee budget (6 bps), activation/dust, and partner fee.
    // This is headroom, not a fee quote; unused funds remain in the wallet.
    const fee = cfg.builder ? (notional * BigInt(cfg.builder.f) + 99_999n) / 100_000n : 0n;
    const takerBudget = (notional * 6n + 9_999n) / 10_000n;
    return { total: margin + 1_100_000n + takerBudget + fee, notional };
  }
  return {
    config,
    snapshot,

    nsPublicKey: hex(root),
    nsAddress: options.nsAddress,

    /** Initial setup is called by connect(); reuse requestId if you retry it yourself. */
    async setup(walletCount = 2, requestId: string = crypto.randomUUID()) {
      return api(
        "/setup",
        setupSchema.parse({ nsAddress: options.nsAddress, walletCount, requestId }),
      );
    },

    /** Revoke new activity on the backend. The React hook also refreshes local connection state. */
    disconnect: () => api("/disconnect", {}),

    /** Safe to poll from the partner app: returns spendable USDC without a popup or signature. */
    async balance() {
      if (options.hosted)
        return z
          .string()
          .regex(/^\d+(?:\.\d+)?$/)
          .parse(await api("/balance"));
      const cfg = await config();
      const result = await notes();
      return formatUnits(
        result.notes
          .filter((n) => hex(n.asset).toLowerCase() === cfg.usdc.toLowerCase())
          .reduce((n, note) => n + BigInt(note.amount), 0n),
        6,
      );
    },

    /** Estimate required USDC, including funding headroom. This does not submit a trade. */
    async estimate(input: Order) {
      const order = orderSchema.parse(input);
      const cfg = await config();
      return formatUnits(funding(order, cfg).total, 6);
    },

    /** Call from the trade button; keep the same order and clientOrderId when retrying. */
    async open(input: Order) {
      const order = orderSchema.parse(input);
      // In the partner app, each new funding intent is approved and signed on ShieldTX.
      if (options.hosted) return options.hosted.open(order);
      if (opening) throw new Error("Another open is being submitted");
      opening = true;
      try {
        const storageKey = options.accountId ? "shieldtx-pending:" + options.accountId : null;
        // A retry resends the saved signed body instead of creating another funding intent.
        const previous = submissions.get(order.clientOrderId);
        if (previous) {
          if (previous.order !== JSON.stringify(order))
            throw new Error("Use a new clientOrderId for a different order");
          const accepted = acceptedSchema.parse(await api("/open", previous.body));
          if (storageKey && localStorage.getItem(storageKey) === order.clientOrderId)
            localStorage.removeItem(storageKey);
          return accepted;
        }
        const [cfg, account] = await Promise.all([config(), snapshot()]);
        if (!cfg.executionEnabled)
          throw new Error("Test execution is disabled; wallet setup remains available");
        const exact = z
          .object({ order: z.object({ tradeId: z.uuid() }).nullable() })
          .parse(await api("/orders/" + order.clientOrderId));
        const existing = exact.order;
        if (existing) {
          if (storageKey && localStorage.getItem(storageKey) === order.clientOrderId)
            localStorage.removeItem(storageKey);
          return { tradeId: existing.tradeId, replay: true };
        }

        // After a reload, reconcile any earlier order before asking for a new signature.
        const pending = storageKey ? localStorage.getItem(storageKey) : null;
        if (pending) {
          const earlier = z
            .object({
              order: z
                .object({ stage: z.string(), terminalStatus: z.string().nullable() })
                .nullable(),
            })
            .parse(await api("/orders/" + z.uuid().parse(pending)));
          if (!earlier.order)
            throw new Error(
              "An earlier submission needs reconciliation; do not rebuild its lost funding body",
            );
          if (!earlier.order.terminalStatus && earlier.order.stage !== "open")
            throw new Error("Wait for the pending funding/open to finish");
          localStorage.removeItem(storageKey!);
        }
        if (account.trades.some((t) => !t.terminalStatus && t.stage !== "open"))
          throw new Error("Wait for the pending funding/open to finish");
        const wallet = account.wallets.find(
          (w) => !w.relay && w.status === "available" && w.revocationState === "active",
        );
        if (
          !wallet ||
          !account.wallets.some(
            (w) => w.relay && w.status === "available" && w.revocationState === "active",
          )
        )
          throw new Error("ShieldTX wallets are not ready. Try again shortly or contact support.");
        const { total, notional } = funding(order, cfg);
        const read = await notes();
        const limits = z
          .object({ max_num_input_notes: z.number().int().positive() })
          .parse(await rpc("getLimits", []));
        const available = read.notes
          .filter((n) => hex(n.asset).toLowerCase() === cfg.usdc.toLowerCase())
          .sort((a, b) => (BigInt(a.amount) > BigInt(b.amount) ? -1 : 1));
        const picked: typeof available = [];
        let sum = 0n;
        for (const note of available) {
          if (sum >= total) break;
          picked.push(note);
          sum += BigInt(note.amount);
        }
        if (sum < total)
          throw new Error(
            `Deposit first: this open requires ${formatUnits(total, 6)} shielded USDC`,
          );
        if (picked.length > limits.max_num_input_notes)
          throw new Error("Too many input notes; consolidate them before trading");
        const inputs = picked.map(noteCommitment);
        const intent: Intent = {
          escrowed_amount: `0x${total.toString(16)}`,
          solver: { bytes: Array.from(raw(cfg.solverPublicKey, 32)) },
          timeout_blocks: 100,
          resolution: {
            Attested: {
              destination_chain: 999,
              recipient_address: Array.from(raw(wallet.address, 20)),
              expected_amount: `0x${total.toString(16)}`,
              expected_asset: Array.from(raw(cfg.usdc, 20)),
              expected_sender: Array.from(raw(cfg.solverAddress, 20)),
            },
          },
        };

        // Match the sequencer's canonical bytes and verify the owner signature locally.
        const signature = await checkedSign(intentHash(inputs, intent));
        const body = {
          clientOrderId: order.clientOrderId,
          dexPositionAccount: wallet.address,
          fundingAmountMicroUsdc: total.toString(),
          pair: order.pair,
          direction: order.direction,
          leverage: order.leverage,
          sizeUsd: formatUnits(notional, 6),
          tpPx: order.tpPx,
          slPx: order.slPx,
          nsOwnerAccount: hex(root),
          sequencerReadAuthTokenHex: hex(read.token),
          sequencerSignedIntent: {
            input_commitments: inputs,
            payload: { CreateIntent: intent },
            signature: { bytes: Array.from(signature) },
          },
        };
        submissions.set(order.clientOrderId, { order: JSON.stringify(order), body });
        if (storageKey) localStorage.setItem(storageKey, order.clientOrderId);
        const accepted = acceptedSchema.parse(await api("/open", body));
        if (storageKey) localStorage.removeItem(storageKey);
        return accepted;
      } finally {
        opening = false;
      }
    },

    /** Close the full position, or cancel an eligible funded trade; reuse the close request ID. */
    close: (tradeId: string, clientOrderId: string = crypto.randomUUID()) =>
      api("/close", { tradeId, clientOrderId, nsOwnerAccount: hex(root) }),

    /** Request or resume the return, then watch reshieldStage and the spendable balance. */
    reshield: (tradeId: string) => api("/reshield", { tradeId }),

    /** Deposit from the user's EVM wallet. Wait for balance() to reflect spendable funds. */
    async deposit(amountUsdc: string, wallet: EthereumWallet): Promise<Hex> {
      const cfg = await config();
      const amount = parseUnits(positive.parse(amountUsdc), 6);
      if (!cfg.executionEnabled)
        throw new Error("Deposits disabled until the test execution path is ready");
      if (amount <= 0n) throw new Error("Deposit must be positive");
      await wallet.switchChain(cfg.chainId);
      const provider = await wallet.getEthereumProvider();
      const chain = cfg.isTestnet ? arbitrumSepolia : arbitrum;
      const publicClient = createPublicClient({ chain, transport: custom(provider) });
      const walletClient = createWalletClient({
        account: wallet.address as Address,
        chain,
        transport: custom(provider),
      });
      const allowance = await publicClient.readContract({
        address: cfg.usdc as Address,
        abi: erc20Abi,
        functionName: "allowance",
        args: [wallet.address as Address, cfg.vault as Address],
      });
      if (allowance < amount) {
        const tx = await walletClient.writeContract({
          address: cfg.usdc as Address,
          abi: erc20Abi,
          functionName: "approve",
          args: [cfg.vault as Address, amount],
        });
        if ((await publicClient.waitForTransactionReceipt({ hash: tx })).status !== "success")
          throw new Error("USDC approval reverted");
      }
      const simulation = await publicClient.simulateContract({
        account: wallet.address as Address,
        address: cfg.vault as Address,
        abi: vaultAbi,
        functionName: "shield",
        args: [cfg.usdc as Address, amount, hex(root), 0n],
      });
      const tx = await walletClient.writeContract(simulation.request);
      if ((await publicClient.waitForTransactionReceipt({ hash: tx })).status !== "success")
        throw new Error("Vault deposit reverted");
      return tx; // Vault confirmation != spendable notes; balance() checks sequencer indexing.
    },
  };
}
