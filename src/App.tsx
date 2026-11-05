"use client";

import { useEffect, useRef, useState } from "react";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { useCreateWallet } from "@privy-io/react-auth/solana";
import { useShieldTx } from "./useShieldTx";
import type { Config, Order, Snapshot } from "./schema";

const short = (s: string) => s.slice(0, 7) + "…" + s.slice(-5);
export function App() {
  const { ready, authenticated, login, logout, connectWallet, user } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { wallets } = useWallets();
  const { client, error: rootError, needsRoot } = useShieldTx();
  const [config, setConfig] = useState<Config | null>(null);
  const [account, setAccount] = useState<Snapshot | null>(null);
  const [balance, setBalance] = useState("—");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deposit, setDeposit] = useState("20");
  const [walletAddress, setWalletAddress] = useState("");
  const [estimate, setEstimate] = useState("—");
  const pending = useRef<Order | null>(null);
  const [order, setOrder] = useState<Omit<Order, "clientOrderId">>({
    pair: "ETH-USD", direction: "long", marginUsdc: "5", leverage: 2, tpPx: "", slPx: "",
  });
  async function refresh() { if (client) setAccount(await client.snapshot()); }
  useEffect(() => {
    setConfig(null); setAccount(null); setBalance("—"); pending.current = null;
    if (!client) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const [cfg, snapshot] = await Promise.all([client.config(), client.snapshot()]);
        if (!cancelled) {
          if (cfg.appId !== process.env.NEXT_PUBLIC_PRIVY_APP_ID) throw new Error("Frontend and backend use different Privy apps");
          setConfig(cfg); setAccount(snapshot);
        }
      } catch (e) { if (!cancelled) setMessage(e instanceof Error ? e.message : "Status unavailable"); }
    };
    void poll(); const timer = setInterval(() => void poll(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [client]);
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void client.estimate({ ...order, clientOrderId: crypto.randomUUID() }).then(x => { if (!cancelled) setEstimate(x); }).catch(() => { if (!cancelled) setEstimate("—"); });
    return () => { cancelled = true; };
  }, [client, order]);
  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage("");
    try { await action(); setMessage(success); await refresh(); }
    catch (e) { setMessage(e instanceof Error ? e.message : "Operation failed"); }
    finally { setBusy(false); }
  }
  const available = account?.wallets.filter(w => !w.relay && w.status === "available" && w.revocationState === "active").length ?? 0;
  const ethereum = wallets.find(w => w.address === walletAddress) ?? wallets[0];
  return <div className="shell">
    <header><div><strong>STRATIUM<span className="accent"> / </span>SHIELDTX</strong><span className="badge">INTEGRATION POC</span></div>
      <button disabled={!ready || busy} onClick={() => authenticated ? void logout() : login()}>{authenticated ? "Sign out" : "Connect with Privy"}</button></header>
    <div className="layout"><aside>
      <span className="eyebrow">PRIVATE EXECUTION</span><h1>Trade normally.<br />Shield the flow.</h1>
      <p className="muted">Your Privy account. User-signed funding. Rust-coordinated execution.</p>
      <div className="metric"><span>Network</span><strong>{config ? config.isTestnet ? "TESTNET" : "MAINNET · REAL FUNDS" : "Not connected"}</strong></div>
      <div className="metric"><span>Shielded USDC</span><strong>{balance}</strong></div>
      <button disabled={!client || busy} onClick={() => void run(async () => setBalance(await client!.balance()), "Balance read from spendable Nightshade notes")}>Refresh shielded balance</button>
      <div className="metric"><span>Available position slots</span><strong>{available}</strong></div>
      {account?.refillCapReached && <p>Lifetime wallet limit reached. Contact support before warming more.</p>}
      <label>Privy user ID<input value={user?.id ?? ""} readOnly /></label>
      <label>NS root address<input value={client?.nsAddress ?? ""} readOnly /></label>
      <button disabled={!client || !config || busy} onClick={() => void run(async () => {
        const key = "stratium-warmup:" + config?.appId + ":" + user?.id;
        const id = localStorage.getItem(key) ?? crypto.randomUUID(); localStorage.setItem(key, id);
        await client!.setup(2, id); localStorage.removeItem(key);
      }, "Two position/relay slots ready")}>Warm 2 slots</button>
      {authenticated && needsRoot && <button disabled={busy} onClick={() => void run(() => createWallet(), "Nightshade root created")}>Create Nightshade root</button>}
      <p className="muted small">Root: {client ? short(client.nsPublicKey) : "Created through Privy on login"}</p>
      <p className="muted small">Policy administration stays separate from the coordinator’s trading signer.</p>
    </aside><main>
      <section><div className="section-heading"><h2>01 / Deposit</h2><span>Arbitrum → Vault → NS notes</span></div>
        <div className="row"><label>USDC<input value={deposit} onChange={e => setDeposit(e.target.value)} inputMode="decimal" /></label>
        <label>Funding wallet<select value={ethereum?.address ?? ""} onChange={e => setWalletAddress(e.target.value)}>{wallets.map(w => <option key={w.address} value={w.address}>{short(w.address)}</option>)}</select></label>
        <button disabled={!client || !config?.executionEnabled || !ethereum || busy || !account?.wallets.length} onClick={() => void run(() => client!.deposit(deposit, ethereum!), "Vault deposit confirmed. Refresh balance after sequencer indexing.")}>Deposit to NS</button>
        <button disabled={busy || !authenticated} onClick={() => connectWallet()}>Connect wallet</button></div>
      </section>
      <section><div className="section-heading"><h2>02 / Open a shielded position</h2><span>Isolated · IOC · TP/SL required</span></div>
        <form onSubmit={e => { e.preventDefault(); if (!client) return; void run(async () => {
          pending.current ??= { ...order, clientOrderId: crypto.randomUUID() };
          const accepted = await client.open(pending.current);
          pending.current = null;
          return accepted;
        }, "Open accepted — follow its actual stage below"); }}>
          <fieldset disabled={!client || !config || busy || pending.current !== null}>
            <div className="grid">
              <label>Market<select value={order.pair} onChange={e => setOrder({ ...order, pair: e.target.value })}>{["ETH-USD", "BTC-USD", "HYPE-USD"].map(p => <option key={p}>{p}</option>)}</select></label>
              <label>Direction<select value={order.direction} onChange={e => setOrder({ ...order, direction: e.target.value as "long" | "short" })}><option value="long">Long</option><option value="short">Short</option></select></label>
              <label>Margin · USDC<input value={order.marginUsdc} onChange={e => setOrder({ ...order, marginUsdc: e.target.value })} inputMode="decimal" required /></label>
              <label>Leverage<input type="number" min="1" max="100" value={order.leverage} onChange={e => setOrder({ ...order, leverage: Number(e.target.value) })} required /></label>
              <label>Take-profit price<input value={order.tpPx} onChange={e => setOrder({ ...order, tpPx: e.target.value })} inputMode="decimal" required /></label>
              <label>Stop-loss price<input value={order.slPx} onChange={e => setOrder({ ...order, slPx: e.target.value })} inputMode="decimal" required /></label>
            </div>
          </fieldset>
          <div className="fee-line"><span>Funding: {estimate} USDC · margin + activation + entry fee budgets</span><span>Builder: {config?.builder ? `${config.builder.f / 10} bps · ${short(config.builder.b)}` : "off"}</span></div>
          {!config?.executionEnabled && <p className="muted small">Setup-only mode: test solver callback and builder funding must be ready before deposits or opens.</p>}
          <button className="primary" disabled={!client || !config?.executionEnabled || busy || !available} type="submit">{busy ? "Working…" : pending.current ? "Retry same open (same ID)" : "Sign funding intent & open"}</button>
        </form>
      </section>
      <section><div className="section-heading"><h2>03 / Positions & operations</h2><span>Accepted ≠ filled</span></div>
        {!account?.trades.length ? <p className="muted">No trades yet. Status comes from the Rust coordinator, not simulated data.</p> :
        <div className="table-scroll"><table><thead><tr><th>Position</th><th>Stage</th><th>Fees / PnL</th><th>Action</th></tr></thead><tbody>
          {account.trades.map(t => <tr key={t.tradeId}><td>{t.pair} · {t.direction}<small>{t.sizeUsd} USD · {t.leverage}× · {short(t.tradeId)}</small></td>
            <td>{t.reshieldStage ?? t.stage}<small>{t.terminalStatus ?? "in progress"}{t.failureReason ? " · " + t.failureReason : ""}</small></td>
            <td>{t.feeTotal} / {t.realizedPnl ?? "—"}</td><td>{t.stage === "open" || t.stage === "funded" ? <button disabled={busy} onClick={() => void run(() => client!.close(t.tradeId), "Close/cancel accepted; Rust handles close and reshield")}>{t.stage === "funded" ? "Cancel & reshield" : "Close fully"}</button> : t.terminalStatus === "succeeded" && t.reshieldStage !== "relay_forwarded" ? <button disabled={busy} onClick={() => void run(() => client!.reshield(t.tradeId), "Reshield enqueued; wait for relay_forwarded")}>Check / resume reshield</button> : "—"}</td></tr>)}
        </tbody></table></div>}
      </section>
      <p className="notice" role="status" aria-live="polite">{rootError || message || "Sign in → warm slots → deposit → sign and trade. No private-key exports."}</p>
    </main></div><footer>Market charts can keep using Hyperliquid directly. Only account setup and order execution use ShieldTX.</footer>
  </div>;
}
