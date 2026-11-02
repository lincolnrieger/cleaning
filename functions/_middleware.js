// Pauses the old Cloudflare Pages address.
//
// The app now runs as a Worker at cleaning.woodhousestaff.app (see
// wrangler.jsonc). The Pages project is kept as a fallback, but its own
// *.pages.dev address shouldn't be used: anyone who opens it is sent to the
// real address, and the API there refuses requests so nothing is recorded
// through the old site by mistake.
//
// Only *.pages.dev is affected. If a custom domain is ever pointed back at the
// Pages project, it works normally again. The Worker never runs this file.

const LIVE = 'https://cleaning.woodhousestaff.app';

export async function onRequest({ request, next }) {
  const url = new URL(request.url); console.log("MW", url.href);
  if (!url.hostname.endsWith('.pages.dev')) return next();

  if (url.pathname.startsWith('/api/')) {
    return new Response(
      JSON.stringify({ error: `This address is no longer used. Open ${LIVE} instead.` }),
      { status: 410, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }

  return Response.redirect(LIVE + url.pathname + url.search, 302);
}
