// Operator-only sandbox bootstrap. This is a CLI, not an HTTP adapter.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export function readEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if (!match) return [];
      const value = match[2]!.trim();
      return [
        [
          match[1]!,
          value.startsWith('"')
            ? z.string().parse(JSON.parse(value))
            : value.startsWith("'") && value.endsWith("'")
              ? value.slice(1, -1)
              : value,
        ],
      ];
    }),
  );
}
export function saveEnv(path: string, values: Record<string, string>) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new Error("Refusing a symlinked environment file");
  const temporary = path + "." + crypto.randomUUID();
  writeFileSync(
    temporary,
    Object.entries(values)
      .map(([key, value]) => {
        if (!/^[A-Z][A-Z0-9_]*$/.test(key))
          throw new Error("Invalid environment key");
        // Bun/dotenv preserve literal JSON inside single quotes; backslash-escaped
        // double quotes aren't decoded consistently by both runtimes.
        return (
          key +
          "=" +
          (value.includes('"') && !value.includes("'") && !value.includes("\n")
            ? "'" + value + "'"
            : JSON.stringify(value))
        );
      })
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  renameSync(temporary, path);
}
type Fetcher = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
const checkpoint = z.object({
  appId: z.string(),
  pending: z.string().optional(),
  resources: z.record(z.string(), z.string()),
});
const resource = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/) });
const domain = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];
export function agentPolicy(owner: string) {
  return {
    version: "1.0",
    name: "stratium-poc-open-close-template",
    chain_type: "ethereum",
    owner_id: owner,
    rules: [
      {
        name: "allow-hyperliquid-l1-action",
        method: "eth_signTypedData_v4",
        action: "ALLOW",
        conditions: [
          {
            field_source: "ethereum_typed_data_domain",
            field: "chainId",
            operator: "eq",
            value: "1337",
          },
          {
            field_source: "ethereum_typed_data_domain",
            field: "verifyingContract",
            operator: "eq",
            value: "0x" + "0".repeat(40),
          },
          {
            field_source: "ethereum_typed_data_message",
            field: "source",
            operator: "eq",
            value: "b",
            typed_data: {
              primary_type: "Agent",
              types: {
                EIP712Domain: domain,
                Agent: [
                  { name: "source", type: "string" },
                  { name: "connectionId", type: "bytes32" },
                ],
              },
            },
          },
        ],
      },
    ],
  };
}
export async function bootstrapSandbox(
  folder: string,
  fetcher: Fetcher = fetch,
) {
  const path = join(folder, ".env");
  if (!existsSync(path))
    throw new Error(
      "Create the local .env with this sandbox's Privy app ID and secret first",
    );
  const dataDir = join(folder, ".data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const lockPath = join(dataDir, "bootstrap.lock");
  const lock = openSync(lockPath, "wx", 0o600);
  try {
    const env = {
      ...readEnv(readFileSync(join(folder, ".env.coordinator.example"), "utf8")),
      ...readEnv(readFileSync(path, "utf8")),
    };
    if (env.IS_TESTNET !== "true" || env.HL_SIGNATURE_CHAIN_ID !== "421614")
      throw new Error(
        "Bootstrap only supports the sandbox/testnet configuration",
      );
    const appId = env.PRIVY_APP_ID,
      secret = env.PRIVY_APP_SECRET;
    if (!appId || !secret || env.NEXT_PUBLIC_PRIVY_APP_ID !== appId)
      throw new Error("Matching dedicated Privy app credentials required");
    // Operator-only. Never mount/copy this file into the coordinator deployment.
    const operatorPath = join(folder, ".env.operator");
    const operator = existsSync(operatorPath)
      ? readEnv(readFileSync(operatorPath, "utf8"))
      : {};
    if (env.PRIVY_POLICY_ADMIN_KEY_PEM) {
      if (
        operator.PRIVY_POLICY_ADMIN_KEY_PEM &&
        operator.PRIVY_POLICY_ADMIN_KEY_PEM !== env.PRIVY_POLICY_ADMIN_KEY_PEM
      )
        throw new Error("Operator key mismatch");
      operator.PRIVY_POLICY_ADMIN_KEY_PEM = env.PRIVY_POLICY_ADMIN_KEY_PEM;
      delete env.PRIVY_POLICY_ADMIN_KEY_PEM;
    }
    const ledger = join(dataDir, "bootstrap.json");
    const state = existsSync(ledger)
      ? checkpoint.parse(JSON.parse(readFileSync(ledger, "utf8")))
      : ({ appId, resources: {} } as z.infer<typeof checkpoint>);
    if (state.appId !== appId)
      throw new Error("Bootstrap ledger belongs to another Privy app");
    if (state.pending)
      throw new Error(
        "Unknown creation outcome for " +
          state.pending +
          "; reconcile Privy and bootstrap.json before retrying",
      );
    const save = () => {
      saveEnv(operatorPath, operator);
      saveEnv(path, env);
      const temporary = ledger + "." + crypto.randomUUID();
      writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      renameSync(temporary, ledger);
    };
    function key(
      target: Record<string, string>,
      privateName: string,
      publicName?: string,
    ) {
      if (target[privateName]) return;
      const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      target[privateName] = pair.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString();
      if (publicName)
        target[publicName] = pair.publicKey
          .export({ type: "spki", format: "pem" })
          .toString();
    }
    key(operator, "PRIVY_POLICY_ADMIN_KEY_PEM");
    key(env, "PRIVY_AUTHZ_PRIVATE_KEY_PEM", "PRIVY_AUTHZ_PUBLIC_KEY_PEM");
    key(env, "PRIVY_SET_MANAGER_KEY_PEM");
    env.AUTH_JWT_SECRET ||= randomBytes(32).toString("hex");
    env.SOLVER_WEBHOOK_SHARED_SECRET ||= randomBytes(32).toString("hex");
    save();
    async function api(method: string, route: string, body?: unknown) {
      let response: Response;
      try {
        response = await fetcher("https://api.privy.io" + route, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
          headers: {
            authorization:
              "Basic " + Buffer.from(appId + ":" + secret).toString("base64"),
            "privy-app-id": appId!,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new Error(
          "Privy network request failed; any pending creation remains fenced",
        );
      }
      if (!response.ok) {
        // Never print provider bodies: they may echo credentials/request details.
        if (
          method === "POST" &&
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408
        ) {
          delete state.pending;
          save();
        }
        throw new Error(
          "Privy " +
            method +
            " " +
            route +
            " rejected (HTTP " +
            response.status +
            ")",
        );
      }
      return response.json() as Promise<unknown>;
    }
    const app = z
      .object({
        id: z.string(),
        verification_key: z.string(),
        allowed_domains: z.array(z.string()),
        email_auth: z.boolean(),
        wallet_auth: z.boolean(),
        guest_auth: z.boolean(),
      })
      .parse(await api("GET", "/v1/apps/" + appId));
    if (app.id !== appId) throw new Error("Privy app identity mismatch");
    env.PRIVY_VERIFICATION_KEY = app.verification_key;
    save();
    async function create(name: string, route: string, body: unknown) {
      if (state.resources[name]) return state.resources[name]!;
      state.pending = name;
      save();
      const response = resource.parse(await api("POST", route, body));
      state.resources[name] = response.id;
      delete state.pending;
      save();
      return response.id;
    }
    const { createPublicKey } = await import("node:crypto");
    const publicKey = (pem: string) =>
      createPublicKey(pem)
        .export({ type: "spki", format: "der" })
        .toString("base64");
    if (
      new Set(
        [
          env.PRIVY_AUTHZ_PRIVATE_KEY_PEM!,
          env.PRIVY_SET_MANAGER_KEY_PEM!,
          operator.PRIVY_POLICY_ADMIN_KEY_PEM!,
        ].map(publicKey),
      ).size !== 3
    )
      throw new Error("Policy admin, set manager and runtime keys must differ");
    for (const [name, pem] of [
      ["PRIVY_POLICY_ADMIN_QUORUM_ID", operator.PRIVY_POLICY_ADMIN_KEY_PEM!],
      ["PRIVY_AUTHZ_KEY_ID", env.PRIVY_AUTHZ_PRIVATE_KEY_PEM!],
      ["PRIVY_SET_MANAGER_QUORUM_ID", env.PRIVY_SET_MANAGER_KEY_PEM!],
    ]) {
      env[name!] ||= await create(name!, "/v1/key_quorums", {
        public_keys: [publicKey(pem!)],
        authorization_threshold: 1,
      });
      const quorum = z
        .object({
          authorization_threshold: z.number(),
          authorization_keys: z.array(z.object({ public_key: z.string() })),
        })
        .parse(await api("GET", "/v1/key_quorums/" + env[name!]));
      if (
        quorum.authorization_threshold !== 1 ||
        !quorum.authorization_keys.some((k) => k.public_key === publicKey(pem!))
      )
        throw new Error("Quorum key mismatch");
      save();
    }
    env.PRIVY_COSIGNER_POLICY_ID ||= await create(
      "PRIVY_COSIGNER_POLICY_ID",
      "/v1/policies",
      agentPolicy(env.PRIVY_POLICY_ADMIN_QUORUM_ID!),
    );
    env.PRIVY_RELAY_POLICY_ID ||= await create(
      "PRIVY_RELAY_POLICY_ID",
      "/v1/policies",
      {
        version: "1.0",
        name: "stratium-poc-relay-sign-message",
        chain_type: "solana",
        owner_id: env.PRIVY_POLICY_ADMIN_QUORUM_ID,
        rules: [
          {
            name: "Sign Nightshade relay messages",
            method: "signMessage",
            action: "ALLOW",
            conditions: [],
          },
        ],
      },
    );
    // A new, empty test builder wallet. This never funds it or submits an HL action.
    env.STRATIUM_BUILDER_WALLET_ID ||= await create(
      "STRATIUM_BUILDER_WALLET_ID",
      "/v1/wallets",
      {
        chain_type: "ethereum",
        owner_id: env.PRIVY_POLICY_ADMIN_QUORUM_ID,
        external_id: "stratium_shieldtx_poc_builder",
      },
    );
    const builder = z
      .object({
        address: z.string().regex(/^0x[0-9a-f]{40}$/i),
        owner_id: z.string(),
      })
      .parse(await api("GET", "/v1/wallets/" + env.STRATIUM_BUILDER_WALLET_ID));
    if (builder.owner_id !== env.PRIVY_POLICY_ADMIN_QUORUM_ID)
      throw new Error("Builder ownership mismatch");
    env.HL_BUILDER_ADDRESS = builder.address.toLowerCase();
    env.HL_BUILDER_FEE_TENTHS_BPS ||= "10";
    save();
    if (env.PUBLIC_PRIVY_PARTNERS_JSON) {
      const partners = z
        .array(
          z
            .object({
              id: z.string(),
              envPrefix: z.string(),
              warmTarget: z.number().optional(),
              walletLimit: z.number().optional(),
            })
            .passthrough(),
        )
        .parse(JSON.parse(env.PUBLIC_PRIVY_PARTNERS_JSON));
      for (const partner of partners)
        if (partner.id === "stratium" && partner.envPrefix === "") {
          partner.warmTarget ??= 2;
          partner.walletLimit ??= 20;
        }
      env.PUBLIC_PRIVY_PARTNERS_JSON = JSON.stringify(partners);
      save();
    }
    return {
      appVerified: true,
      verificationKeyConfigured: true,
      adminRuntimeKeysSeparate: true,
      quorumsReady: true,
      policiesReady: true,
      builderAddress: env.HL_BUILDER_ADDRESS,
      builderFeeBps: Number(env.HL_BUILDER_FEE_TENTHS_BPS) / 10,
      allowedDomains: app.allowed_domains,
      emailLogin: app.email_auth,
      walletLogin: app.wallet_auth,
      missingExecutionConfig: [
        "VAULT_ADDRESS",
        "SEQUENCER_RPC_URL",
        "SOLVER_NS_PUBLIC_KEY_HEX",
        "SOLVER_EXPECTED_SENDER_ADDRESS",
      ].filter((name) => !env[name]),
    };
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
if (import.meta.main) {
  try {
    console.info(
      JSON.stringify(await bootstrapSandbox(process.cwd()), null, 2),
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Sandbox bootstrap failed",
    );
    process.exitCode = 1;
  }
}
