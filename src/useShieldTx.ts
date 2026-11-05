"use client";

// This is the partner's frontend glue; their charts, forms and login stay theirs.
import { useEffect, useMemo, useRef, useState } from "react";
import bs58 from "bs58";
import { usePrivy } from "@privy-io/react-auth";
import { useWallets, useSignMessage } from "@privy-io/react-auth/solana";
import { createShieldTxClient } from "./client";
import { raw } from "./crypto";
import { profileSchema, snapshotSchema } from "./schema";
const apiUrl = process.env.NEXT_PUBLIC_SHIELDTX_API_URL ?? "http://127.0.0.1:4100/api/shieldtx";

export function useShieldTx() {
  const { user, getAccessToken } = usePrivy();
  const { wallets } = useWallets();
  const { signMessage } = useSignMessage();
  const callbacks = useRef({ getAccessToken, signMessage, wallets });
  callbacks.current = { getAccessToken, signMessage, wallets };
  const linked = user?.linkedAccounts.find(a => a.type === "wallet" && a.chainType === "solana" && ["privy", "privy-v2"].includes(a.walletClientType ?? ""));
  const candidate = linked?.type === "wallet" ? linked.address : null;
  const [binding, setBinding] = useState<{ did: string; address: string | null } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    void (async () => {
      const token = await callbacks.current.getAccessToken();
      if (!token) throw new Error("Sign in first");
      const response = await fetch(apiUrl + "/account", { headers: { authorization: "Bearer " + token } });
      if (!response.ok) throw new Error("Account setup API unavailable");
      const account = snapshotSchema.parse(await response.json());
      if (!cancelled) {
        setBinding(previous => ({ did: user.id, address: account.nsRoot ? bs58.encode(raw(account.nsRoot, 32)) : previous?.did === user.id && previous.address ? previous.address : candidate }));
        setError("");
      }
    })().catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : "Root binding unavailable"); });
    return () => { cancelled = true; };
  }, [user?.id, candidate]);
  const wallet = wallets.find(w => binding?.did === user?.id && w.address === binding?.address);
  const client = useMemo(() => wallet ? createShieldTxClient({
    baseUrl: apiUrl,
    nsAddress: wallet.address, getAccessToken: () => callbacks.current.getAccessToken(),
    getProfile: async () => {
      const token = await callbacks.current.getAccessToken();
      if (!token) throw new Error("Sign in first");
      const response = await fetch("/api/profile", {
        method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ nsAddress: wallet.address }), signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error("Partner policy setup is unavailable or needs reconciliation; retry the same setup");
      return profileSchema.parse(await response.json());
    },
    signBytes: async message => {
      const active = callbacks.current.wallets.find(w => w.address === wallet.address);
      if (!active) throw new Error("Reconnect your Nightshade wallet");
      return (await callbacks.current.signMessage({ wallet: active, message })).signature;
    },
  }) : null, [wallet?.address, user?.id]);
  return { client, error, needsRoot: binding?.did === user?.id && !binding?.address };
}
