import { z } from "zod";

export const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/i);

export const address = z.string().regex(/^0x[0-9a-f]{40}$/i);

export const bytes = (size: number) => z.array(z.number().int().min(0).max(255)).length(size);

// User-entered USDC amounts use decimal strings with at most six decimal places.

export const positive = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/)
  .refine((x) => Number(x) > 0);

export const builderSchema = z
  .object({ b: address, f: z.number().int().min(1).max(100) })
  .nullable();

// Validate coordinator responses before the UI uses addresses or account state.

export const configSchema = z.object({
  appId: z.string(),
  isTestnet: z.boolean(),
  vault: address,
  usdc: address,
  chainId: z.number().int(),
  solverPublicKey: hex32,
  solverAddress: address,
  builder: builderSchema,
  executionEnabled: z.boolean().default(false),
  provisioning: z.enum(["split-control", "server-managed"]).optional(),
  providerAppId: z.string().nullable().optional(),
  authAppOrigin: z.url().nullable().optional(),
  warmTarget: z.number().int().min(0).max(10).optional(),
  walletLimit: z.number().int().min(1).max(100).optional(),
});

export type Config = z.infer<typeof configSchema>;

export const walletSchema = z.object({
  address,
  status: z.string(),
  phase: z.string().nullable(),
  relay: z.boolean(),
  nsPublicKey: hex32.nullable(),
  revocationState: z.string(),
});

export const tradeSchema = z.object({
  tradeId: z.uuid(),
  clientOrderId: z.string(),
  stage: z.string(),
  terminalStatus: z.string().nullable(),
  pair: z.string(),
  direction: z.string(),
  leverage: z.number(),
  sizeUsd: z.string(),
  entryPx: z.string().nullable(),
  feeTotal: z.string(),
  realizedPnl: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  reshieldStage: z.string().nullable(),
  builder: builderSchema.optional(),
});

export const snapshotSchema = z.object({
  connection: z
    .object({ accountId: z.uuid(), providerAppId: z.string(), active: z.boolean(), nsRoot: hex32 })
    .nullable()
    .optional(),
  wallets: z.array(walletSchema),
  trades: z.array(tradeSchema),
  builder: builderSchema,
  nsRoot: hex32.nullable().optional(),
  setupReady: z.boolean().default(false),
  walletPairsCreated: z.number().int().nonnegative().optional(),
  refillCapReached: z.boolean().optional(),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

// Pass this shape to estimate() and open(); the client builds the signed HTTP request.

export const orderSchema = z
  .object({
    clientOrderId: z.uuid(),
    pair: z.string().regex(/^[A-Z0-9]+-USD$/),
    direction: z.enum(["long", "short"]),
    marginUsdc: positive,
    leverage: z.number().int().min(1).max(100),
    tpPx: positive,
    slPx: positive,
  })
  .strict();

export type Order = z.infer<typeof orderSchema>;

// Setup accepts a fixed root, batch ID and count; policies stay on the backend.

export const setupSchema = z
  .object({
    nsAddress: z.string().min(32).max(44),
    requestId: z.uuid(),
    walletCount: z.number().int().min(1).max(3),
  })
  .strict();

export const acceptedSchema = z.object({
  tradeId: z.uuid(),
  replay: z.boolean(),
});

// Raw notes are used by the native signing path, not by partner balance polling.

export const noteSchema = z.object({
  amount: z.string().regex(/^(?:0x[0-9a-f]+|\d+)$/i),
  asset: bytes(20),
  nonce: bytes(32),
  owner: z.object({ Key: z.object({ bytes: bytes(32) }) }),
});

export type Note = z.infer<typeof noteSchema>;
