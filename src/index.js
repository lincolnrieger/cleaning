// Woodhouse Cleaning Tracker - Worker entry point.
//
// The site runs as a Cloudflare Worker with static assets. Everything in
// public/ is served straight from Cloudflare's edge without this code running;
// only /api/* reaches it (see run_worker_first in wrangler.jsonc).
//
// The API itself still lives in functions/api/ and keeps its Pages-style
// onRequest(context) signature, so this file is just the adapter between the
// two: it builds the small context object the API expects and hands over.

import { onRequest } from '../functions/api/[[path]].js';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      return onRequest({
        request,
        env,
        // Wrapped so waitUntil is never called detached from ctx.
        waitUntil: (p) => ctx.waitUntil(p),
      });
    }

    // Anything else is a static file (or the app shell for an unknown path).
    return env.ASSETS.fetch(request);
  },
};
