# Agent-readiness (isitagentready.com) — prep for the Cloudflare move

Baseline scan of the current GitHub Pages site (`axeforging.github.io/kompact/`):
**Level 0 "Not Ready", 0/16 passed.** The cause is hosting, not content — the
scanner checks the *domain root* for `/robots.txt`, `/sitemap.xml`, `.well-known/*`
and DNS, plus HTTP `Link` headers and Markdown negotiation. A GitHub *project*
subpath can't serve root files or set response headers, so the checks 404.

The files in this folder make those checks pass **once the site is on Cloudflare
Pages behind a custom domain**. Nothing here is faked: MCP/OAuth/commerce/A2A
manifests are intentionally omitted because this is a docs site with no such
endpoints — inventing them would mislead agents (and score no honest points).

## Do this when moving to Cloudflare Pages

1. Create a Cloudflare Pages project from this repo; set the **output/root
   directory to `docs`**. Keep Pages **Functions** enabled (the `functions/`
   folder here powers Markdown negotiation).
2. Add your **custom domain** in Pages, and point DNS at Cloudflare.
3. Find-and-replace the token **`REPLACE_ME_DOMAIN`** with your domain in:
   - `robots.txt` (the `Sitemap:` line)
   - `sitemap.xml` (every `<loc>`)
   Then re-run the scan.
4. **DNS-AID** (DNS for AI Discovery) is DNS, not a file — add it in Cloudflare
   DNS per https://agenticresourcediscovery.org/ . It can only be done once the
   domain is live in Cloudflare; that's the last Discoverability check.

## What each file satisfies

| File | isitagentready check(s) |
| --- | --- |
| `robots.txt` | Discoverability → robots.txt; Bot Access Control → AI bot rules + Content Signals |
| `sitemap.xml` | Discoverability → Sitemap |
| `_headers` | Discoverability → Link headers (RFC 8288) — **Cloudflare Pages only** |
| `functions/_middleware.js` + `index.md` | Content Accessibility → Markdown negotiation — **Cloudflare Pages only** |
| `llms.txt` | Not scored by this tool, but the de-facto agent content map — worth having |

## Intentionally NOT added (would be dishonest for a docs site)
- MCP Server Card, WebMCP, A2A Agent Card, Agent Skills index, ARD manifest,
  API Catalog, OAuth discovery/protected-resource, auth.md — no such endpoints exist.
- Commerce (x402, MPP, UCP, ACP, AP2) — not a commerce site; the scanner already
  marks these *neutral*, not failing.
- Web Bot Auth — server-side request signing; the scanner treats it as informational.

## GitHub Pages note
`_headers` and `functions/` are inert on GitHub Pages (served as static files or
ignored), so committing them now does no harm to the current site.
