# @pipeworx/italy-tenders

Italian public-procurement tender notices from ANAC (Autorità Nazionale
Anticorruzione), the national anti-corruption authority that runs Italy's
tender/contract register. Fleet #3091.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1807+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `it_tender_search(query?, cpv?, buyer?, province?, date_from?, date_to?, limit?)`
  -- search tender notices by free-text keyword (title + CPV category
  description), CPV classification code/prefix, buyer (contracting
  authority) name substring, Italian province, and a publish-date range
  (defaults to the last 90 days). Returns each notice's CIG, title, buyer,
  province/region, contract type, amount (EUR), status, CPV, publish date,
  offer deadline, and outcome when ANAC has recorded one.
- `it_tender_detail(cig)` -- the full record for one notice by its CIG
  (Codice Identificativo Gara), including buyer tax code, cost center,
  procedure type, realization mode, lot count, and outcome communication
  date.

Every response carries `source`, `source_url`, `licence`, `data_as_of`, and
(on `it_tender_search`/no-match responses) `window_from`/`window_to` --
the span of months this pack currently holds -- so a caller can tell "no
tenders on this topic" apart from "that date range isn't loaded".

## Auth

Keyless. The tools answer only through the Pipeworx gateway, which holds
the data; a standalone install has no data to read, and every tool
returns a clear "store is not bound in this runtime" error there instead
of an empty list.

## Data sources

- Autorità Nazionale Anticorruzione (ANAC) -- Italy's national
  anti-corruption authority, which runs the country's public-procurement
  notice register. ANAC publishes the register as open data
  (dati.anticorruzione.it, a CKAN portal) but only as bulk monthly dumps:
  every contracts resource has `datastore_active: false` (no server-side
  search/filter), so this pack builds a store from ANAC's own "cig-YYYY"
  monthly CSVs (`scripts/italy-tenders/load-data.mjs`) rather than
  proxying per request. The only live endpoint ANAC exposes is a
  single-CIG lookup with no discovery path -- not useful for
  keyword/buyer/CPV/date search, which is what this pack answers.

  **Licence (quoted verbatim from ANAC's own CKAN `package_show` API,
  checked live 2026-10-15):** the `cig-YYYY` package reports
  `"license_title": "Creative Commons Attribution Share-Alike 4.0"`,
  `"license_id": "CC-BY-SA-4.0"`; each monthly resource additionally
  carries `"license_type": "https://w3id.org/italia/controlled-vocabulary/licences/A31_CCBYSA40"`.
  CC-BY-SA-4.0 explicitly permits reuse and redistribution, with
  attribution and share-alike -- this is not a case the "mirror needs a
  reuse grant" rule (`mirror-needs-grant-proxy-does-not`, Bruce,
  2026-09-08) holds for; the grant is already in the licence. Attribution
  is carried in every response's `source`/`source_url` fields.

### Known gaps -- read before extending this pack

**This pack holds a ROLLING RECENT WINDOW, not ANAC's full history.** The
`cig` register runs back to 2007 (`cig-2007` through `cig-2025` as
separate yearly datasets on ANAC's portal); one month's CSV alone runs
~115-120k rows / ~100MB uncompressed (measured live for September 2025).
Loading the full ~19-year history into one D1 database would dwarf every
other store-backed pack here. `it_tender_search`/`it_tender_detail` report
their loaded window (`window_from`/`window_to`, from the `it_meta` table)
on every no-match response, so a caller can tell a genuinely empty result
apart from a date outside what is loaded.

ANAC's OCDS twin of this data (`ocds-appalti-ordinari-YYYY`, also monthly)
was checked and rejected for THIS pack's refresh: one month's JSON release
package ran **748MB-3.1GB** (measured live for 2026-03 and 2025-09), far
larger than the CSV `cig-YYYY` resources used here for the same notices.
Note also: ANAC/Italy already has a SEPARATE, slower-cadence presence in
`mcps/open-contracting` (the OCP Data Registry's own weekly OCDS mirror of
18 countries) -- that coverage was confirmed live but stale (no
`latest_release` recorded for Italy in `oc_coverage`, and sampled rows
dated 2021-2022) at the time this pack was built, which is the actual gap
this pack closes: ANAC/Italy with a genuinely recent window.

**`it_tender_detail`'s live-enrichment possibility (`getSmartCig`) was not
wired.** An earlier dropped build (fleet #3088) noted a live single-CIG
lookup at `api.anticorruzione.it/apicig/.../getSmartCig/{cig}`; every path
variant guessed during this build 404'd, and ANAC's own API gateway
(`api.anticorruzione.it/apicig/swagger/v1/swagger.json`) also 404'd, so the
exact live path could not be confirmed. Not critical: the loaded `cig-YYYY`
CSV already carries full notice detail per CIG (status, outcome,
cancellation fields), so `it_tender_detail` answers entirely from the
store. If a working live endpoint is found later, it would only add
enrichment ANAC communicates in between monthly refreshes.

### Refreshing the data

`node scripts/italy-tenders/load-data.mjs --months 2026-09,2026-10 [--retain-from 2025-11] [--init-schema on the very first run]`
-- downloads each requested month's `cig-YYYY` CSV zip from ANAC, streams
and upserts rows into D1 (`INSERT OR REPLACE`, keyed by `cig`, so
re-loading a month already present just refreshes rows ANAC updated --
e.g. an outcome communicated weeks after publication). Needs `wrangler`
logged in to the Pipeworx Cloudflare account and the `unzip` CLI.

The GitHub workflow `.github/workflows/italy-tenders-refresh.yml` runs
this monthly, re-pulling the current and previous two months (to catch
late outcome updates) and rolling `--retain-from` forward so the table
does not grow without bound.

### Pre-deploy smoke testing (no production D1 needed)

```
node --experimental-strip-types scripts/italy-tenders/build-local-sqlite.mjs \
  --csv <a downloaded cig_csv_YYYY_MM.csv> --ym YYYY-MM --out /tmp/italy-tenders.sqlite
node --experimental-strip-types scripts/italy-tenders/smoke-local.mjs /tmp/italy-tenders.sqlite
```

Exercises the pack's real `callTool()` against a local SQLite file built
from a real ANAC monthly CSV via a `D1Like` adapter -- same shape as
`scripts/fracfocus/{build-local-sqlite,smoke-local}.mjs`.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "italy-tenders": {
      "url": "https://gateway.pipeworx.io/italy-tenders/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/italy-tenders/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1807+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/it_tender_search \
  -H 'Content-Type: application/json' \
  -d '{"buyer":"COMUNE DI MILANO","date_from":"2025-12-01","date_to":"2025-12-31","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/it_tender_search`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "italy-tenders": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-italy-tenders"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-italy-tenders
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Italy Tenders data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
