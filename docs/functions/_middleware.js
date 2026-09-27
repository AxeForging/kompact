// Cloudflare Pages Function: Markdown content negotiation for agents.
// https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/
// When a client sends `Accept: text/markdown`, serve the .md mirror of the page.
// Ignored by GitHub Pages (which serves this file statically and harmlessly).
export async function onRequest(context) {
  const { request, next, env } = context;
  const accept = request.headers.get('Accept') || '';
  if (!accept.includes('text/markdown')) return next();

  const url = new URL(request.url);
  let path = url.pathname;
  if (path === '/' || path.endsWith('/')) path += 'index.html';
  if (!path.endsWith('.html')) return next(); // only HTML pages have md mirrors
  const mdPath = path.replace(/\.html$/, '.md');

  const md = await env.ASSETS.fetch(new URL(mdPath, url.origin));
  if (!md.ok) return next(); // no mirror for this page -> serve HTML as usual
  return new Response(await md.text(), {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Vary': 'Accept',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
