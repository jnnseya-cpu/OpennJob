/**
 * The web app is a static export: `next build` writes plain HTML, CSS and JS to `out/`,
 * which any static host can serve. Everything personal is fetched from the API in the
 * browser with the user's own access token; nothing is rendered on a server.
 *
 * The API address is read at run time from `/opennjob-config.json` (see src/lib/api.ts),
 * so one build can be pointed at any API.
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  trailingSlash: true,
  reactStrictMode: true,
  poweredByHeader: false,
  images: { unoptimized: true },
  // No ESLint set-up in this repository; `npm run typecheck` is the check.
  eslint: { ignoreDuringBuilds: true },
  experimental: {
    // Pack definitions, countries and languages come from packages/core/src (see src/lib/core.ts).
    externalDir: true,
  },
};

export default nextConfig;
