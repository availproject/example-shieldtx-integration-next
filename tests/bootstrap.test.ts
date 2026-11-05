import { expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapSandbox, readEnv, saveEnv } from "../scripts/bootstrap-privy";
import { provisionProfile } from "../scripts/provision-profile";
const nsAddress = "CZ8YUVdk7znjrUmnb5n7kgySk9yRAsQDYmyCxzfSky9t";
function folder(testnet = true) {
  const dir = mkdtempSync(join(tmpdir(), "stratium-bootstrap-test-"));
  writeFileSync(
    join(dir, ".env.coordinator.example"),
    "IS_TESTNET=true\nHL_SIGNATURE_CHAIN_ID=421614\n",
  );
  saveEnv(join(dir, ".env"), {
    PRIVY_APP_ID: "test-app",
    NEXT_PUBLIC_PRIVY_APP_ID: "test-app",
    PRIVY_APP_SECRET: "not-a-real-secret",
    IS_TESTNET: String(testnet),
    HL_SIGNATURE_CHAIN_ID: testnet ? "421614" : "42161",
    VAULT_ADDRESS: "0x" + "22".repeat(20),
  });
  return dir;
}
function harness(unknown = false) {
  let writes = 0;
  const quorums = new Map<string, unknown>();
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/apps/test-app")
      return Response.json({
        id: "test-app",
        verification_key: "test-public-key",
        allowed_domains: [],
        email_auth: true,
        wallet_auth: true,
        guest_auth: false,
      });
    if (path.startsWith("/v1/users/"))
      return Response.json({
        id: "did:privy:user",
        linked_accounts: [
          {
            type: "wallet",
            chain_type: "solana",
            wallet_client_type: "privy",
            address: nsAddress,
          },
        ],
      });
    if (init?.method === "POST") {
      writes++;
      if (unknown) throw new Error("Simulated response loss");
      expect([
        "/v1/key_quorums",
        "/v1/policies",
        "/v1/wallets",
        "/v1/condition_sets",
      ]).toContain(path);
      const id = String(writes).padStart(24, "x");
      if (path === "/v1/key_quorums") {
        const body = JSON.parse(String(init.body)) as { public_keys: string[] };
        quorums.set(id, {
          authorization_threshold: 1,
          authorization_keys: body.public_keys.map((public_key) => ({
            public_key,
          })),
        });
      }
      return Response.json({ id });
    }
    if (path.startsWith("/v1/key_quorums/"))
      return Response.json(quorums.get(path.split("/").at(-1)!));
    if (path.startsWith("/v1/wallets/"))
      return Response.json({
        address: "0x" + "11".repeat(20),
        owner_id: "1".padStart(24, "x"),
      });
    throw new Error("Unexpected endpoint");
  };
  return { fetcher, writes: () => writes };
}
test("sandbox bootstrap separates keys, limits creations and reuses all resources", async () => {
  const dir = folder();
  const h = harness();
  const first = await bootstrapSandbox(dir, h.fetcher);
  expect(first.quorumsReady).toBe(true);
  expect(h.writes()).toBe(6);
  expect(await bootstrapSandbox(dir, h.fetcher)).toEqual(first);
  expect(h.writes()).toBe(6);
  const env = readEnv(readFileSync(join(dir, ".env"), "utf8"));
  expect(env.PRIVY_POLICY_ADMIN_KEY_PEM).toBeUndefined();
  const operator = readEnv(readFileSync(join(dir, ".env.operator"), "utf8"));
  expect(
    new Set([
      operator.PRIVY_POLICY_ADMIN_KEY_PEM,
      env.PRIVY_AUTHZ_PRIVATE_KEY_PEM,
      env.PRIVY_SET_MANAGER_KEY_PEM,
    ]).size,
  ).toBe(3);
  expect(env.HL_BUILDER_FEE_TENTHS_BPS).toBe("10");
  expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, ".env.operator")).mode & 0o777).toBe(0o600);
  const ledger = readFileSync(join(dir, ".data/bootstrap.json"), "utf8");
  expect(ledger).not.toContain("not-a-real-secret");
  expect(ledger).not.toContain("PRIVATE KEY");
});
test("C operator creates an actor-bound profile once; foreign roots and unknown creates are fenced", async () => {
  const dir = folder(),
    h = harness();
  await bootstrapSandbox(dir, h.fetcher);
  const profile = await provisionProfile(
    dir,
    "did:privy:user",
    nsAddress,
    h.fetcher,
  );
  expect(Object.keys(profile).sort()).toEqual(
    ["policyId", "positionSetId", "relaySetId"].sort(),
  );
  expect(h.writes()).toBe(9);
  expect(
    await provisionProfile(dir, "did:privy:user", nsAddress, h.fetcher),
  ).toEqual(profile);
  expect(h.writes()).toBe(9);
  await expect(
    provisionProfile(dir, "did:privy:other", nsAddress, h.fetcher),
  ).rejects.toThrow("Root is not");
  const lostDir = folder(),
    lost = harness();
  await bootstrapSandbox(lostDir, lost.fetcher);
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") throw new Error("lost response");
    return lost.fetcher(url, init);
  };
  await expect(
    provisionProfile(lostDir, "did:privy:user", nsAddress, fetcher),
  ).rejects.toThrow("lost response");
  await expect(
    provisionProfile(lostDir, "did:privy:user", nsAddress, lost.fetcher),
  ).rejects.toThrow("Unknown creation outcome");
  expect(lost.writes()).toBe(6);
});
test("unknown creation is fenced; retry cannot create duplicates", async () => {
  const dir = folder();
  const h = harness(true);
  await expect(bootstrapSandbox(dir, h.fetcher)).rejects.toThrow(
    "pending creation",
  );
  await expect(bootstrapSandbox(dir, h.fetcher)).rejects.toThrow(
    "Unknown creation outcome",
  );
  expect(h.writes()).toBe(1);
});
test("concurrent bootstrap cannot replace the operator key or interleave ledgers", async () => {
  const dir = folder(),
    h = harness();
  let release!: () => void, reached!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const first = bootstrapSandbox(dir, async (url, init) => {
    if (String(url).endsWith("/v1/apps/test-app")) {
      reached();
      await hold;
    }
    return h.fetcher(url, init);
  });
  await started;
  try {
    await expect(bootstrapSandbox(dir, h.fetcher)).rejects.toThrow("EEXIST");
  } finally {
    release();
  }
  await first;
  expect(h.writes()).toBe(6);
  expect(await bootstrapSandbox(dir, h.fetcher)).toMatchObject({
    quorumsReady: true,
  });
  expect(h.writes()).toBe(6);
});
test("mainnet and symlinked secret files are rejected", async () => {
  const h = harness();
  await expect(bootstrapSandbox(folder(false), h.fetcher)).rejects.toThrow(
    "sandbox/testnet",
  );
  expect(h.writes()).toBe(0);
  const dir = folder();
  symlinkSync(join(dir, ".env"), join(dir, "link"));
  expect(() => saveEnv(join(dir, "link"), { SECRET: "never-written" })).toThrow(
    "symlinked",
  );
});
test("partner JSON survives both the CLI parser and Bun environment loading", async () => {
  const dir = folder();
  const profiles = JSON.stringify([
    {
      id: "stratium",
      envPrefix: "",
      allowedOrigins: ["http://127.0.0.1:5173"],
      executionEnabled: false,
    },
  ]);
  saveEnv(join(dir, ".env"), { PUBLIC_PRIVY_PARTNERS_JSON: profiles });
  expect(
    readEnv(readFileSync(join(dir, ".env"), "utf8")).PUBLIC_PRIVY_PARTNERS_JSON,
  ).toBe(profiles);
  const child = Bun.spawn(
    [
      "bun",
      "--env-file=" + join(dir, ".env"),
      "-e",
      "console.log(JSON.parse(process.env.PUBLIC_PRIVY_PARTNERS_JSON)[0].id)",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect((await new Response(child.stdout).text()).trim()).toBe("stratium");
});
