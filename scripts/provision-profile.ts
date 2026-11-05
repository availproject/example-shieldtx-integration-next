// Local operator fallback. Vercel uses the same provisioning core with durable storage.
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { v5 } from "uuid";
import { readEnv } from "./bootstrap-privy";
import { provisionProfileResources, type ProfileStore, type Fetcher } from "../server/provision";

export async function provisionProfile(folder: string, did: string, nsAddress: string, fetcher: Fetcher = fetch) {
  const env = readEnv(readFileSync(join(folder, ".env"), "utf8"));
  const operator = readEnv(readFileSync(join(folder, ".env.operator"), "utf8"));
  if (env.IS_TESTNET !== "true" || env.HL_SIGNATURE_CHAIN_ID !== "421614")
    throw new Error("Profile CLI is sandbox/testnet only");
  const directory = join(folder, ".data");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "profile-" + v5(env.PRIVY_APP_ID + ":" + did, v5.URL) + ".json");
  const lockPath = path + ".lock";
  const lock = openSync(lockPath, "wx", 0o600);
  const store: ProfileStore = {
    load: async () => existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined,
    save: async state => {
      const temp = path + "." + crypto.randomUUID();
      writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      renameSync(temp, path);
    },
  };
  try {
    return await provisionProfileResources(env, operator.PRIVY_POLICY_ADMIN_KEY_PEM ?? "", did, nsAddress, store, fetcher);
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
if (import.meta.main) {
  try { console.info(JSON.stringify(await provisionProfile(process.cwd(), process.argv[2] ?? "", process.argv[3] ?? ""), null, 2)); }
  catch {
    console.error("Profile provisioning failed; check operator configuration and pending ledger. Unknown creations are not retried.");
    process.exitCode = 1;
  }
}
