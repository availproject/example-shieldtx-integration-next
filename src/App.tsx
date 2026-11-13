"use client";

import { useEffect, useRef, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useShieldTx } from "./useShieldTx";
import { ShieldTxApiError } from "./client";
import { formatUnits } from "viem";
import type { Config, Order, Snapshot, Withdrawal } from "./schema";

const short = (s: string) => s.slice(0, 7) + "…" + s.slice(-5);

const phaseLabel: Record<Withdrawal["phase"], string> = {
  enqueued: "Queued for proving",
  proved: "Proved · awaiting L1 batch",
  claimable: "Ready to claim",
  claimed: "Claimed",
};

/** Working UI wiring for connection, automatic balances, deposits, trading and withdrawals. */
export function App() {
  const { ready, authenticated, login, logout, connectWallet, user } = usePrivy();
  const currentUser = useRef(user?.id);
  currentUser.current = user?.id;
  const { wallets } = useWallets();
  const {
    client,
    error: rootError,
    connect,
    disconnect,
    renewReadSession,
    unshield,
    authorizeWithdrawals,
    withdrawalToken,
    clearWithdrawalToken,
    canConnect,
    connected,
  } = useShieldTx();
  const [config, setConfig] = useState<Config | null>(null);
  const [account, setAccount] = useState<Snapshot | null>(null);
  const [balance, setBalance] = useState("—");
  const [balanceError, setBalanceError] = useState("");
  const [renewalRequired, setRenewalRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [pollError, setPollError] = useState("");
  const [deposit, setDeposit] = useState("20");
  const [walletAddress, setWalletAddress] = useState("");
  const [estimate, setEstimate] = useState("—");
  const [withdrawAmount, setWithdrawAmount] = useState("10");
  const [withdrawRecipient, setWithdrawRecipient] = useState("");
  const [withdrawals, setWithdrawals] = useState<Withdrawal[] | null>(null);
  const [withdrawalsError, setWithdrawalsError] = useState("");
  const pending = useRef<Order | null>(null);
  const [order, setOrder] = useState<Omit<Order, "clientOrderId">>({
    pair: "ETH-USD",
    direction: "long",
    marginUsdc: "5",
    leverage: 2,
    tpPx: "",
    slPx: "",
  });

  // Refresh once after an action; ignore results if the user changed while it was running.
  async function refresh() {
    const did = currentUser.current;
    if (client) {
      const snapshot = await client.snapshot();
      if (currentUser.current === did) setAccount(snapshot);
    }
  }
  useEffect(() => {
    setBusy(false);
    setMessage("");
    pending.current = null;
  }, [user?.id]);

  // Wallet and trade status can be polled without asking the user to sign.
  useEffect(() => {
    setConfig(null);
    setAccount(null);
    setBalance("—");
    setPollError("");
    pending.current = null;
    if (!client) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const [cfg, snapshot] = await Promise.all([client.config(), client.snapshot()]);
        if (!cancelled) {
          if (cfg.appId !== process.env.NEXT_PUBLIC_PRIVY_APP_ID)
            throw new Error("Frontend and backend use different Privy apps");
          setConfig(cfg);
          setAccount(snapshot);
          setPollError("");
        }
      } catch (e) {
        if (!cancelled) setPollError(e instanceof Error ? e.message : "Status unavailable");
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client]);

  // Keep balances current silently. An expired read session gets a separate renewal button.
  useEffect(() => {
    setBalance("—");
    setBalanceError("");
    setRenewalRequired(false);
    if (!client || !connected) return;
    let cancelled = false,
      reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const value = await client.balance();
        if (!cancelled) {
          setBalance(value);
          setBalanceError("");
          setRenewalRequired(false);
        }
      } catch (error) {
        if (!cancelled) {
          setBalance("—");
          setBalanceError(error instanceof Error ? error.message : "Balance unavailable");
          setRenewalRequired(
            error instanceof ShieldTxApiError && error.code === "READ_SESSION_REQUIRED",
          );
        }
      } finally {
        reading = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, connected]);

  // Withdrawal progress needs a read token from the ShieldTX page; polling never signs.
  useEffect(() => {
    setWithdrawals(null);
    setWithdrawalsError("");
    if (!client || !withdrawalToken) return;
    let cancelled = false,
      reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const list = await client.withdrawals(withdrawalToken);
        if (!cancelled) {
          setWithdrawals(list);
          setWithdrawalsError("");
        }
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ShieldTxApiError && error.code === "READ_TOKEN_REJECTED") {
          clearWithdrawalToken();
          setWithdrawalsError("Withdrawal access expired; allow it again to see progress");
        } else setWithdrawalsError(error instanceof Error ? error.message : "Withdrawals unavailable");
      } finally {
        reading = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [client, withdrawalToken]);

  // Update the funding estimate as the order form changes; this does not sign or submit.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client
      .estimate({ ...order, clientOrderId: crypto.randomUUID() })
      .then((x) => {
        if (!cancelled) setEstimate(x);
      })
      .catch(() => {
        if (!cancelled) setEstimate("—");
      });
    return () => {
      cancelled = true;
    };
  }, [client, order]);

  // Calling action() immediately preserves the click gesture needed to open the approval window.
  async function run(action: () => Promise<unknown>, success: string) {
    const did = currentUser.current;
    setBusy(true);
    setMessage("");
    try {
      await action();
      if (currentUser.current === did) {
        setMessage(success);
        await refresh();
      }
    } catch (e) {
      if (currentUser.current === did)
        setMessage(e instanceof Error ? e.message : "Operation failed");
    } finally {
      if (currentUser.current === did) setBusy(false);
    }
  }
  const available =
    account?.wallets.filter(
      (w) => !w.relay && w.status === "available" && w.revocationState === "active",
    ).length ?? 0;
  const ethereum = wallets.find((w) => w.address === walletAddress) ?? wallets[0];
  const recipient = withdrawRecipient || ethereum?.address || "";
  return (
    <div className="shell">
      <header>
        <div>
          <strong>
            STRATIUM<span className="accent"> / </span>SHIELDTX
          </strong>
          <span className="badge">INTEGRATION POC</span>
        </div>
        <button disabled={!ready || busy} onClick={() => (authenticated ? void logout() : login())}>
          {authenticated ? "Sign out" : "Connect with Privy"}
        </button>
      </header>
      <div className="layout">
        <aside>
          <span className="eyebrow">PRIVATE EXECUTION</span>
          <h1>
            Trade normally.
            <br />
            Shield the flow.
          </h1>
          <p className="muted">
            Your Privy account. User-signed funding. Rust-coordinated execution.
          </p>
          <button
            disabled={!authenticated || !canConnect || busy}
            onClick={() =>
              void run(
                connected ? disconnect : connect,
                connected
                  ? "ShieldTX connection revoked; new activity blocked"
                  : "ShieldTX connected and initial wallets ready",
              )
            }
          >
            {connected ? "Disconnect ShieldTX" : "Connect ShieldTX"}
          </button>
          <div className="metric">
            <span>Network</span>
            <strong>
              {config ? (config.isTestnet ? "TESTNET" : "MAINNET · REAL FUNDS") : "Not connected"}
            </strong>
          </div>
          <div className="metric">
            <span>Shielded USDC</span>
            <strong>{balance}</strong>
          </div>
          {balanceError && (
            <p role="status" className="muted small">
              {balanceError}
            </p>
          )}
          {renewalRequired && (
            <button
              disabled={!connected || busy}
              onClick={() =>
                void run(async () => {
                  setBalance(await renewReadSession());
                  setBalanceError("");
                  setRenewalRequired(false);
                }, "Automatic balance updates resumed")
              }
            >
              Refresh ShieldTX session
            </button>
          )}
          {account?.refillCapReached && (
            <p>Wallet capacity reached. Contact support if you cannot open a new position.</p>
          )}
          <label>
            Privy user ID
            <input value={user?.id ?? ""} readOnly />
          </label>
          <label>
            NS root address
            <input value={client?.nsAddress ?? ""} readOnly />
          </label>
          <p className="muted small">
            Root: {client ? short(client.nsPublicKey) : "Created through Privy on login"}
          </p>
          <p className="muted small">
            Policy administration stays separate from the coordinator’s trading signer.
          </p>
        </aside>
        <main>
          <section>
            <div className="section-heading">
              <h2>01 / Deposit</h2>
              <span>Arbitrum → Vault → NS notes</span>
            </div>
            <div className="row">
              <label>
                USDC
                <input
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                  inputMode="decimal"
                />
              </label>
              <label>
                Funding wallet
                <select
                  value={ethereum?.address ?? ""}
                  onChange={(e) => setWalletAddress(e.target.value)}
                >
                  {wallets.map((w) => (
                    <option key={w.address} value={w.address}>
                      {short(w.address)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={
                  !client ||
                  !connected ||
                  !config?.executionEnabled ||
                  !ethereum ||
                  busy
                }
                onClick={() =>
                  void run(
                    () => client!.deposit(deposit, ethereum!),
                    "Vault deposit confirmed. Refresh balance after sequencer indexing.",
                  )
                }
              >
                Deposit to NS
              </button>
              <button disabled={busy || !authenticated} onClick={() => connectWallet()}>
                Connect wallet
              </button>
            </div>
          </section>
          <section>
            <div className="section-heading">
              <h2>02 / Open a shielded position</h2>
              <span>Isolated · IOC · TP/SL required</span>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!client) return;
                void run(async () => {
                  // Preserve this order ID after an error so Retry cannot create a second trade.
                  pending.current ??= { ...order, clientOrderId: crypto.randomUUID() };
                  const accepted = await client.open(pending.current);
                  pending.current = null;
                  return accepted;
                }, "Open accepted — follow its actual stage below");
              }}
            >
              <fieldset disabled={!client || !config || busy || pending.current !== null}>
                <div className="grid">
                  <label>
                    Market
                    <select
                      value={order.pair}
                      onChange={(e) => setOrder({ ...order, pair: e.target.value })}
                    >
                      {["ETH-USD", "BTC-USD", "HYPE-USD"].map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Direction
                    <select
                      value={order.direction}
                      onChange={(e) =>
                        setOrder({ ...order, direction: e.target.value as "long" | "short" })
                      }
                    >
                      <option value="long">Long</option>
                      <option value="short">Short</option>
                    </select>
                  </label>
                  <label>
                    Margin · USDC
                    <input
                      value={order.marginUsdc}
                      onChange={(e) => setOrder({ ...order, marginUsdc: e.target.value })}
                      inputMode="decimal"
                      required
                    />
                  </label>
                  <label>
                    Leverage
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={order.leverage}
                      onChange={(e) => setOrder({ ...order, leverage: Number(e.target.value) })}
                      required
                    />
                  </label>
                  <label>
                    Take-profit price
                    <input
                      value={order.tpPx}
                      onChange={(e) => setOrder({ ...order, tpPx: e.target.value })}
                      inputMode="decimal"
                      required
                    />
                  </label>
                  <label>
                    Stop-loss price
                    <input
                      value={order.slPx}
                      onChange={(e) => setOrder({ ...order, slPx: e.target.value })}
                      inputMode="decimal"
                      required
                    />
                  </label>
                </div>
              </fieldset>
              <div className="fee-line">
                <span>Funding: {estimate} USDC · margin + activation + entry fee budgets</span>
                <span>
                  Builder:{" "}
                  {config?.builder
                    ? `${config.builder.f / 10} bps · ${short(config.builder.b)}`
                    : "off"}
                </span>
              </div>
              {!config?.executionEnabled && (
                <p className="muted small">
                  Setup-only mode: test solver callback and builder funding must be ready before
                  deposits or opens.
                </p>
              )}
              <button
                className="primary"
                disabled={!client || !connected || !config?.executionEnabled || busy || !available}
                type="submit"
              >
                {busy
                  ? "Working…"
                  : pending.current
                    ? "Retry same open (same ID)"
                    : "Sign funding intent & open"}
              </button>
            </form>
          </section>
          <section>
            <div className="section-heading">
              <h2>03 / Positions & operations</h2>
              <span>Accepted ≠ filled</span>
            </div>
            {!account?.trades.length ? (
              <p className="muted">
                No trades yet. Status comes from the Rust coordinator, not simulated data.
              </p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Position</th>
                      <th>Stage</th>
                      <th>Fees / PnL</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.trades.map((t) => (
                      <tr key={t.tradeId}>
                        <td>
                          {t.pair} · {t.direction}
                          <small>
                            {t.sizeUsd} USD · {t.leverage}× · {short(t.tradeId)}
                          </small>
                        </td>
                        <td>
                          {t.reshieldStage ?? t.stage}
                          <small>
                            {t.terminalStatus ?? "in progress"}
                            {t.failureReason ? " · " + t.failureReason : ""}
                          </small>
                        </td>
                        <td>
                          {t.feeTotal} / {t.realizedPnl ?? "—"}
                        </td>
                        <td>
                          {t.stage === "open" || t.stage === "funded" ? (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () => client!.close(t.tradeId),
                                  "Close/cancel accepted; Rust handles close and reshield",
                                )
                              }
                            >
                              {t.stage === "funded" ? "Cancel & reshield" : "Close fully"}
                            </button>
                          ) : t.terminalStatus === "succeeded" &&
                            t.reshieldStage !== "relay_forwarded" ? (
                            <button
                              disabled={busy}
                              onClick={() =>
                                void run(
                                  () => client!.reshield(t.tradeId),
                                  "Reshield enqueued; wait for relay_forwarded",
                                )
                              }
                            >
                              Check / resume reshield
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <section>
            <div className="section-heading">
              <h2>04 / Withdraw</h2>
              <span>NS notes → proven batch → Arbitrum claim</span>
            </div>
            <div className="row">
              <label>
                USDC
                <input
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  inputMode="decimal"
                />
              </label>
              <label>
                Arbitrum recipient
                <input
                  value={recipient}
                  onChange={(e) => setWithdrawRecipient(e.target.value.trim())}
                  placeholder="0x…"
                  spellCheck={false}
                />
              </label>
              <button
                disabled={!client || !connected || !recipient || busy}
                onClick={() =>
                  void run(
                    () => unshield(withdrawAmount, recipient),
                    "Unshield queued. It becomes claimable after the next proven batch (up to ~2 hours).",
                  )
                }
              >
                Unshield to Arbitrum
              </button>
            </div>
            {!withdrawalToken ? (
              <div className="row">
                <p className="muted small">
                  {withdrawalsError || "Withdrawal progress needs one approval on the ShieldTX page."}
                </p>
                <button
                  disabled={!client || !connected || busy}
                  onClick={() => void run(authorizeWithdrawals, "Withdrawal history loaded")}
                >
                  Show withdrawals
                </button>
              </div>
            ) : withdrawalsError ? (
              <p className="muted small">{withdrawalsError}</p>
            ) : !withdrawals ? (
              <p className="muted">Loading withdrawals…</p>
            ) : !withdrawals.length ? (
              <p className="muted">No withdrawals yet.</p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Withdrawal</th>
                      <th>Status</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {withdrawals.map((w) => (
                      <tr key={w.id}>
                        <td>
                          {formatUnits(BigInt(w.amount), 6)} USDC
                          <small>
                            to {short(w.recipient)} · {short(w.id)}
                          </small>
                        </td>
                        <td>
                          {phaseLabel[w.phase]}
                          <small>
                            {w.batchNumber === null ? "not in a batch yet" : `batch ${w.batchNumber}`}
                          </small>
                        </td>
                        <td>
                          {w.phase === "claimable" ? (
                            <button
                              disabled={!ethereum || busy}
                              onClick={() =>
                                void run(async () => {
                                  const tx = await client!.claim(w, ethereum!);
                                  setWithdrawals((list) =>
                                    list?.map((x) => (x.id === w.id ? { ...x, phase: "claimed" } : x)) ?? list,
                                  );
                                  return tx;
                                }, "Claimed on Arbitrum; USDC sent to the recipient")
                              }
                            >
                              Claim on Arbitrum
                            </button>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          <p className="notice" role="status" aria-live="polite">
            {rootError ||
              pollError ||
              message ||
              "Sign in → connect ShieldTX → deposit → sign and trade → withdraw. No private-key exports."}
          </p>
        </main>
      </div>
      <footer>
        Market charts can keep using Hyperliquid directly. Only account setup and order execution
        use ShieldTX.
      </footer>
    </div>
  );
}
