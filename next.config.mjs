/** @type {import('next').NextConfig} */
export default {
  webpack(config) {
    // The email/wallet example does not use Privy's optional Farcaster connector.
    config.resolve.alias["@farcaster/mini-app-solana"] = false;
    return config;
  },
};
