"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { App } from "./App";
const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();
export function ShieldTxApp() {
  return (
  appId ? <PrivyProvider appId={appId} config={{
    loginMethods: ["email", "wallet"], appearance: { theme: "dark", accentColor: "#b5f46c" },
    supportedChains: [arbitrumSepolia, arbitrum],
    defaultChain: arbitrumSepolia,
    embeddedWallets: { ethereum: { createOnLogin: "all-users" }, solana: { createOnLogin: "all-users" } },
  }}><App /></PrivyProvider> : <main className="configuration">
    <span className="eyebrow">STRATIUM × SHIELDTX · INTEGRATION POC</span>
    <h1>Your trading UI.<br />A shielded execution path.</h1>
    <p>Configure the dedicated Privy app in <code>.env.local</code> to enable real login, deposits and trades.</p>
    <ol><li>Set <code>NEXT_PUBLIC_PRIVY_APP_ID</code>, <code>NEXT_PUBLIC_SHIELDTX_API_URL</code> and matching coordinator credentials.</li><li>Use the coordinator URL supplied by Avail and configure partner onboarding on your server.</li><li>Sign in, warm slots, deposit through the vault, then trade.</li></ol>
    <p className="muted">No mock orders, balances or signatures. See README.md for setup.</p>
  </main>
  );
}
