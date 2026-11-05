import type { Metadata } from "next";
import type { ReactNode } from "react";
import "../src/style.css";

export const metadata: Metadata = {
  title: "ShieldTX integration example",
  description: "Privy login, wallet prewarming, shielded open, close and reshield.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
