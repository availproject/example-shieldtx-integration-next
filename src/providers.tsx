"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { arbitrum, arbitrumSepolia } from "viem/chains";
import { App } from "./App";
const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID?.trim();

/** Use your existing partner Privy app; ShieldTX handles its own login on its hosted page. */
export function ShieldTxApp() {
  return appId ? (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["email", "wallet"],
        appearance: { theme: "dark", accentColor: "#b5f46c" },
        supportedChains: [arbitrumSepolia, arbitrum],
        defaultChain: arbitrumSepolia,
        embeddedWallets: { ethereum: { createOnLogin: "all-users" } },
      }}
    >
      <App />
    </PrivyProvider>
  ) : (
    <main className="configuration">
      <span className="eyebrow">STRATIUM × SHIELDTX · INTEGRATION POC</span>
      <h1>
        Your trading UI.
        <br />A shielded execution path.
      </h1>
      <p>
        Configure the dedicated Privy app in <code>.env.local</code> to enable real login, deposits
        and trades.
      </p>
      <ol>
        <li>
          Set the public <code>NEXT_PUBLIC_PRIVY_APP_ID</code> and{" "}
          <code>NEXT_PUBLIC_SHIELDTX_API_URL</code>.
        </li>
        <li>Use the coordinator URL supplied by Avail.</li>
        <li>Sign in, connect ShieldTX, then use the bound ShieldTX wallets.</li>
      </ol>
      <p className="muted">No mock orders, balances or signatures. See README.md for setup.</p>
    </main>
  );
}
