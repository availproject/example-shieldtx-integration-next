"use client";

import dynamic from "next/dynamic";

const ShieldTxApp = dynamic(() => import("../src/providers").then(module => module.ShieldTxApp), {
  ssr: false,
  loading: () => <main>Loading ShieldTX…</main>,
});

export default function Page() {
  return <ShieldTxApp />;
}
