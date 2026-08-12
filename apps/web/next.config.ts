import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages ship TypeScript source rather than a build artifact,
  // so Next transpiles them directly. This is what removes the build step from
  // local development.
  transpilePackages: ['@stealth/core', '@stealth/data'],
  typedRoutes: true,
};

export default config;
