// The browser talks only to our site (/backend/...), and Next forwards requests to the API server.
// This way the session cookie belongs to one address (httpOnly, SameSite=Lax) and no CORS setup is needed.
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const isProd = process.env.NODE_ENV === 'production';

// Resource loading policy: only our own site. 'unsafe-inline' for scripts is needed by Next (its internal inserts),
// 'unsafe-eval' only in development. data: images are needed for the clinic logo from Cliniccards.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self' https://www.liqpay.ua",
  "object-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }] : []),
];

/** @type {import('next').NextConfig} */
export default {
  // A separate build folder lets a test build run without disturbing a running development server
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/backend/:path*', destination: `${API_URL}/:path*` }];
  },
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // The service worker must not stick in the browser cache, otherwise an app update would reach users late
      { source: '/sw.js', headers: [{ key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' }, { key: 'Service-Worker-Allowed', value: '/' }] },
    ];
  },
};
