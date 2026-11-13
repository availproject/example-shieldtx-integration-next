"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import bs58 from "bs58";
import { z } from "zod";
import { usePrivy } from "@privy-io/react-auth";
import { createShieldTxClient } from "./client";
import { raw } from "./crypto";
import {
  configSchema,
  readTokenSchema,
  snapshotSchema,
  unshieldResultSchema,
  type Config,
  type Snapshot,
} from "./schema";
import { openShieldTxWindow, type Operation } from "./connection";

const apiUrl = process.env.NEXT_PUBLIC_SHIELDTX_API_URL ?? "http://localhost:4102/api/shieldtx";

/** Use inside your existing PrivyProvider; this hook connects the current user to ShieldTX. */
export function useShieldTx() {
  const { user, getAccessToken } = usePrivy();
  // Keep requests tied to the current user, including while a popup is open.
  const current = useRef({ did: user?.id, getAccessToken });
  current.current = { did: user?.id, getAccessToken };
  const abort = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const [loaded, setLoaded] = useState<{ did: string; config: Config; account: Snapshot } | null>(
    null,
  );
  const [error, setError] = useState("");
  // Sequencer read token for withdrawal history. Memory only; reload asks again.
  const [withdrawalAccess, setWithdrawalAccess] = useState<{ did: string; token: string } | null>(
    null,
  );

  // Ask Privy for the current token on each request so refreshes work automatically.
  async function api(path: string, body?: unknown) {
    const did = current.current.did;
    const token = await current.current.getAccessToken();
    if (!did || !token || current.current.did !== did) throw new Error("Sign in first");
    const response = await fetch(apiUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    if (!response.ok) {
      const problem = z
        .object({ error: z.object({ message: z.string() }) })
        .safeParse(await response.json().catch(() => null));
      throw new Error(problem.success ? problem.data.error.message : "ShieldTX unavailable");
    }
    const result: unknown = await response.json();
    if (current.current.did !== did) throw new Error("Account changed during request");
    return result;
  }

  // Reload connection and wallet readiness without opening the ShieldTX window.
  async function refresh() {
    const did = current.current.did;
    if (!did) return null;
    const version = generation.current;
    const [config, account] = await Promise.all([
      api("/config").then((value) => configSchema.parse(value)),
      api("/account").then((value) => snapshotSchema.parse(value)),
    ]);
    if (config.appId !== process.env.NEXT_PUBLIC_PRIVY_APP_ID)
      throw new Error("Frontend and coordinator use different requester apps");
    if (current.current.did !== did || generation.current !== version) return null;
    const value = { did, config, account };
    setLoaded(value);
    setError("");
    return value;
  }

  // Watch account changes and discard responses from an earlier login.
  useEffect(() => {
    generation.current++;
    abort.current?.abort();
    abort.current = new AbortController();
    setLoaded(null);
    setError("");
    setWithdrawalAccess(null);
    if (!user) return;
    let cancelled = false;
    const poll = () =>
      void refresh().catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Account unavailable");
      });
    poll();
    const timer = setInterval(poll, 5000);
    return () => {
      generation.current++;
      cancelled = true;
      clearInterval(timer);
      abort.current?.abort();
    };
  }, [user?.id]);
  const active = loaded?.did === user?.id ? loaded : null;
  const binding = active?.account.connection;

  // The coordinator supplies the approved login/signing origin.
  function hosted(request: Operation) {
    const did = active?.did;
    const origin = active?.config.authAppOrigin;
    const signal = abort.current?.signal;
    if (!origin || !signal || !did || current.current.did !== did)
      throw new Error("Wait for ShieldTX configuration");
    return openShieldTxWindow({
      origin,
      request,
      getAccessToken: () => current.current.getAccessToken(),
      isCurrent: () => current.current.did === did,
      signal,
    });
  }

  // Partner calls use this app's JWT. Root signing stays in the ShieldTX window.
  const client = useMemo(
    () =>
      binding && active?.account.nsRoot
        ? createShieldTxClient({
            baseUrl: apiUrl,
            nsAddress: bs58.encode(raw(active.account.nsRoot, 32)),
            getAccessToken: async () => {
              const did = active.did;
              if (current.current.did !== did) throw new Error("Account changed; refresh ShieldTX");
              const token = await current.current.getAccessToken();
              if (current.current.did !== did) throw new Error("Account changed; refresh ShieldTX");
              return token;
            },
            signBytes: async () => {
              throw new Error("Root signing requires the ShieldTX page");
            },
            hosted: {
              open: async (order) =>
                z
                  .object({ tradeId: z.uuid(), replay: z.boolean() })
                  .parse(await hosted({ operation: "open", accountId: binding.accountId, order })),
            },
          })
        : null,
    [
      user?.id,
      binding?.active,
      binding?.accountId,
      active?.account.nsRoot,
      active?.config.authAppOrigin,
    ],
  );

  /** Call from the Connect ShieldTX button. Login and initial wallet setup happen here. */
  async function connect() {
    const did = current.current.did;
    await hosted({ operation: "connect" });
    if (current.current.did !== did) throw new Error("Account changed during connection");
    generation.current++;
    const value = await refresh();
    if (!value || value.did !== did || !value.account.connection?.active || !value.account.nsRoot)
      throw new Error("Connection did not become active");

    // Preserve the setup ID across retries so a lost response cannot create another batch.
    if (!value.account.setupReady) {
      const key = "shieldtx-initial-setup:" + value.account.connection.accountId;
      const requestId = localStorage.getItem(key) ?? crypto.randomUUID();
      localStorage.setItem(key, requestId);
      await api("/setup", {
        nsAddress: bs58.encode(raw(value.account.nsRoot, 32)),
        requestId,
        walletCount: 2,
      });
      if (current.current.did !== did) return;
      localStorage.removeItem(key);
      await refresh();
    }
  }

  /** Call from a user click after READ_SESSION_REQUIRED; balance polling should never open a popup. */
  async function renewReadSession() {
    if (!binding?.active) throw new Error("Connect ShieldTX first");
    return z.string().parse(await hosted({ operation: "balance", accountId: binding.accountId }));
  }

  /**
   * Call from the Unshield button. The ShieldTX page signs the withdrawal and relays it;
   * funds become claimable on Arbitrum after the next proven batch.
   */
  async function unshield(amountUsdc: string, recipient: string) {
    const did = current.current.did;
    if (!binding?.active || !did) throw new Error("Connect ShieldTX first");
    const result = unshieldResultSchema.parse(
      await hosted({ operation: "unshield", accountId: binding.accountId, amountUsdc, recipient }),
    );
    if (current.current.did === did) setWithdrawalAccess({ did, token: result.readToken });
    return result;
  }

  /** Call from a user click: the ShieldTX page signs a read token for withdrawal history. */
  async function authorizeWithdrawals() {
    const did = current.current.did;
    if (!binding?.active || !did) throw new Error("Connect ShieldTX first");
    const { readToken } = readTokenSchema.parse(
      await hosted({ operation: "withdrawals", accountId: binding.accountId }),
    );
    if (current.current.did === did) setWithdrawalAccess({ did, token: readToken });
  }

  /** Revoke new backend activity, close pending popups, then reload connection status. */
  async function disconnect() {
    generation.current++;
    setWithdrawalAccess(null);
    await api("/disconnect", {});
    generation.current++;
    abort.current?.abort();
    abort.current = new AbortController();
    await refresh();
  }

  // After connect() finishes, use the client returned by the next React render.
  return {
    client,
    error,
    connect,
    disconnect,
    renewReadSession,
    unshield,
    authorizeWithdrawals,
    withdrawalToken: withdrawalAccess?.did === user?.id ? (withdrawalAccess?.token ?? null) : null,
    /** Drop an expired withdrawal read token so the UI asks for access again. */
    clearWithdrawalToken: () => setWithdrawalAccess(null),
    canConnect: !!active?.config.authAppOrigin,
    connected: !!binding?.active,
  };
}
