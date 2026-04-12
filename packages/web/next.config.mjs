/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // wagmi v2 / viem require these packages to be transpiled for Next.js
  transpilePackages: ['wagmi', 'viem', '@wagmi/core', '@wagmi/connectors'],
};

export default nextConfig;
