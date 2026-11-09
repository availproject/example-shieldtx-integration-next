/** @type {import('next').NextConfig} */
export default {
  // Isolate this validation run from an already-running local example server.
  distDir: process.env.SHIELDTX_BUILD_DIR ?? ".next",
  webpack(config) {
    // The email/wallet example does not use Privy's optional Farcaster connector.
    config.resolve.alias["@farcaster/mini-app-solana"] = false;
    return config;
  },
};
