import { importSPKI, jwtVerify } from "jose";
import { z } from "zod";
import { ProfileError, provisionProfileResources, type ProfileStore } from "./provision";

const settings = z.object({
  APP_ORIGIN: z.url(), PRIVY_APP_ID: z.string().min(1), PRIVY_APP_SECRET: z.string().min(1),
  PRIVY_VERIFICATION_KEY: z.string().min(1), PRIVY_POLICY_ADMIN_KEY_PEM: z.string().min(1),
  PRIVY_POLICY_ADMIN_QUORUM_ID: z.string().min(1), PRIVY_SET_MANAGER_QUORUM_ID: z.string().min(1),
  PRIVY_AUTHZ_KEY_ID: z.string().min(1), IS_TESTNET: z.enum(["true", "false"]),
  HL_SIGNATURE_CHAIN_ID: z.string().min(1), VAULT_ADDRESS: z.string().min(1),
  HL_BUILDER_ADDRESS: z.string().optional(), HL_BUILDER_FEE_TENTHS_BPS: z.string().optional(),
});
const input = z.object({ nsAddress: z.string().min(32).max(64) }).strict();
type Dependencies = {
  env: Record<string, string | undefined>; store: ProfileStore;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};
function error(status: number, code: string, message: string) {
  return Response.json({ error: { code, message, retryable: ["PROFILE_BUSY", "PRIVY_RATE_LIMITED"].includes(code) } }, {
    status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export async function handleProfile(request: Request, dependencies: Dependencies): Promise<Response> {
  if (request.method !== "POST") return error(405, "METHOD_NOT_ALLOWED", "Use POST");
  const token = request.headers.get("authorization")?.match(/^Bearer (\S{1,8192})$/)?.[1];
  if (!token) return error(401, "UNAUTHORIZED", "Sign in with Privy");
  const parsed = settings.safeParse(dependencies.env);
  if (!parsed.success) return error(503, "PROFILE_UNAVAILABLE", "Partner onboarding is not configured");
  const env = parsed.data;
  if (request.headers.has("origin") && request.headers.get("origin") !== env.APP_ORIGIN)
    return error(403, "ORIGIN_NOT_ALLOWED", "Use the partner app");
  let did: string;
  try {
    const key = await importSPKI(env.PRIVY_VERIFICATION_KEY.replaceAll("\\n", "\n"), "ES256");
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["ES256"], audience: env.PRIVY_APP_ID, issuer: "privy.io",
      requiredClaims: ["sub", "exp", "iat", "aud", "iss"], clockTolerance: 0,
    });
    if (payload.aud !== env.PRIVY_APP_ID || typeof payload.sub !== "string" || !/^did:privy:[a-zA-Z0-9_-]{1,100}$/.test(payload.sub) ||
        typeof payload.iat !== "number" || typeof payload.exp !== "number" ||
        payload.iat > Date.now() / 1000 + 30 || payload.exp <= payload.iat) throw new Error("Invalid token");
    did = payload.sub;
  } catch { return error(401, "UNAUTHORIZED", "Invalid or expired Privy access token"); }
  let nsAddress: string;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > 2048) return error(413, "INVALID_REQUEST", "Request too large");
    nsAddress = input.parse(JSON.parse(text)).nsAddress;
  }
  catch { return error(400, "INVALID_REQUEST", "Send only nsAddress"); }
  try {
    const values = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const profile = await provisionProfileResources(values, env.PRIVY_POLICY_ADMIN_KEY_PEM, did, nsAddress, dependencies.store, dependencies.fetcher);
    return Response.json(profile, { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  } catch (failure) {
    if (failure instanceof ProfileError) return error(failure.status, failure.code, failure.message);
    return error(503, "PROFILE_UNAVAILABLE", "Profile setup failed; unknown creation outcomes stay fenced for reconciliation");
  }
}
