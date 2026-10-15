interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * The class routing tokens, and the two safe ways to wrap a message carrying one.
 *
 * A pack signals an error's class with a leading token — `user_error:`,
 * `upstream_down:`, `upstream_throttled:`, `not_found:`, `blocked_host:`. The
 * gateway's classifier anchors on `^`, and `stripClassPrefix` (which hides the
 * token from the caller) anchors on `^` too. So the convention has one failure
 * mode, and it is silent: a catch block that wraps the message —
 * `` `${slug}/${tool}: ${message}` `` — pushes the token off position 0. The
 * error then books as `error` ("Pipeworx has a defect") instead of as the
 * caller mistake it is, AND the raw token leaks into what the caller reads.
 *
 * Nothing about that fails loudly. The call still returns, the message still
 * reads plausibly, and the misclassification only shows up as a pack sitting on
 * the Problem Tools list for a bug it does not have. Found live in
 * `medicaid-intelligence` on 2026-08-21; the same wrapper template is copied
 * across 18 DMV packs, none of which emit a token *yet*.
 *
 * `scripts/check-error-class-prefix.mjs` is the gate that keeps this honest —
 * it fails any pack that both emits a token and wraps a caught message without
 * using one of the helpers below.
 */

/**
 * The canonical token set. `workers/gateway/src/error-class.ts` carries its own
 * copy on the read side (it is deliberately importable without pulling a pack
 * in); the gate asserts the two agree, because this list has already drifted
 * twice — `not_found:` and `blocked_host:` were honoured by the classifier and
 * not stripped, so both went out to callers verbatim for months.
 */
const CLASS_TOKENS = [
  'upstream_down',
  'upstream_throttled',
  'user_error',
  'not_found',
  'blocked_host',
  // `blocked_url:` is emitted at position 0 from five sites in ssrf.ts
  // (`assertPublicHttpUrl`, and every redirect hop in `safeFetch`) and was in
  // NEITHER reader — so it went to callers verbatim for its whole life. Caught
  // 2026-08-21 by a live n8n call, which answered a private instance_url with
  // "…host). blocked_url: refusing to fetch non-public or non-https URL".
  // Exactly the drift the gate now blocks.
  'blocked_url',
  // `auth_required:` joins the list 2026-08-29 (fleet #638). It exists for the
  // same reason `user_error:` does: a bare 401/403 in an upstream body matches
  // the `upstream_throttled` heuristic below before anything auth-specific, so
  // a pack that needs to say "this is a credential problem, not a rate limit"
  // has no wording-based route — only the explicit-prefix escape hatch works.
  // tiingo and open-sanctions both reached for it on their own, on the
  // (reasonable, but wrong at the time) assumption that any snake_case class
  // already meant something to the gateway. Neither shipped a leak from
  // MIS-CLASSIFICATION — the `error` field was already correct — the leak was
  // the literal token riding along in `message`, unstripped, because this list
  // didn't know the token either reader was seeing.
  'auth_required',
] as const;

const CLASS_PREFIX_RE =
  /^(?:upstream_down|upstream_throttled|user_error|not_found|blocked_host|blocked_url|auth_required)\s*:\s*/;

/**
 * Split a caught message into its leading routing token (possibly empty) and
 * the human-readable body, so a wrapper can put the token back on the front.
 *
 *   const { token, body } = splitClassPrefix(message);
 *   return { error: `${token}my-pack/${name}: ${body}` };
 *
 * The `${token}` must be the FIRST thing in the template — that is the whole
 * point, and it is what the gate checks.
 */
function splitClassPrefix(message: string): { token: string; body: string } {
  const token = message.match(CLASS_PREFIX_RE)?.[0] ?? '';
  return { token, body: message.slice(token.length) };
}

/**
 * Drop a leading routing token from a message that is about to become a
 * FRAGMENT of a larger one — a per-mirror failure joined into "all providers
 * failed (...)", say. Hoisting is wrong there: the fragment never reaches
 * position 0, so the token cannot route anything and would only leak. The outer
 * message declares its own class.
 */
function dropClassPrefix(message: string): string {
  return message.replace(CLASS_PREFIX_RE, '');
}
/**
 * Italy public procurement MCP — ANAC (Autorità Nazionale Anticorruzione)
 * national tender/contract register.
 *
 * SOURCE: ANAC runs Italy's public-procurement notice register and
 * publishes it as open data at dati.anticorruzione.it (CKAN). Every
 * contracts dataset there — "cig" (the main register: one row per CIG,
 * Codice Identificativo Gara, the unique id every Italian public contract
 * above a minimal threshold must carry) and its OCDS twin — ships ONLY as
 * bulk monthly dumps: datastore_active is false on every resource (no
 * server-side search/filter), and the one live endpoint ANAC exposes is a
 * single-CIG lookup with no discovery path (keyword/buyer/CPV/date search is
 * not possible against ANAC's own API). Per Bruce's standing rule
 * (2026-09-23): when live doesn't serve, build the store yourself, with a
 * refresh path and data_as_of on every response. See src/store.ts for how
 * the data is held (D1, loaded by scripts/italy-tenders/load-data.mjs —
 * never a bundled import).
 *
 * WINDOW: this pack holds a ROLLING recent window of the "cig" dataset
 * (not full history back to 2007) — see README.md "Known gaps" for the
 * exact months currently loaded. The monthly dataset runs ~115k rows /
 * ~100MB uncompressed per month; a multi-year load would dwarf what a
 * single-pack D1 database should carry. CIG rows that update after
 * publication (an award communicated weeks later, a cancellation) are
 * refreshed when the refresh workflow re-pulls the trailing months of the
 * window, not just the newest one — see the workflow's header.
 *
 * LICENCE: ANAC publishes "cig"/"cig-YYYY" under Creative Commons
 * Attribution-ShareAlike 4.0 (CC-BY-SA-4.0) — confirmed live via
 * dati.anticorruzione.it's own CKAN package_show API, 2026-10-15. That
 * licence explicitly permits redistribution (with attribution + share-alike)
 * — this is not a case the "mirror needs grant" rule holds for. Quoted in
 * full in README.md.
 *
 * All tools return shaped, LLM-friendly objects (never raw CSV passthrough)
 * and never throw — fetch/parse failures resolve to { error, retry_hint }.
 */

import { requireDb, getMeta, getTender, searchTenders, shapeFull, shapeSummary, isValidDate, SOURCE } from './store.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_WINDOW_DAYS = 90; // default search window when no dates given — ANAC publishes monthly, so "recent" means the newest loaded month(s), not the newest day

function capped(limit: unknown, fallback = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  const n = typeof limit === 'number' ? limit : typeof limit === 'string' && limit.trim() && Number.isFinite(Number(limit)) ? Number(limit) : fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}

function strArg(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  return undefined;
}

function today(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function addDays(dateStr: string, delta: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const tools: McpToolExport['tools'] = [
  {
    name: 'it_tender_search',
    description:
      'Search ITALIAN public-sector tenders and contract notices from ANAC (Autorità Nazionale Anticorruzione), the national anti-corruption authority that runs Italy\'s public-procurement notice register (the "cig" dataset — one notice per CIG, Codice Identificativo Gara). ANAC exposes no live search of its own, so this answers from a locally refreshed recent-window copy (see data_as_of and the window fields in the response). Filter by free-text keyword (matched against the Italian title and CPV category description), CPV code or prefix (e.g. "45" for construction, "72000000" for IT services), buyer name substring (Italian spelling, e.g. "Comune di Milano", "ASL", "Regione"), Italian province code, and a publish-date range. Returns compact shaped notices: CIG, title, buyer, province/region, contract type, amount (EUR), status, CPV, publish date, offer deadline, and outcome if communicated. Call it_tender_detail with a CIG for the full record.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword(s), case-insensitive, matched against the Italian notice title and CPV category description, e.g. "ospedale", "pulizia", "software", "manutenzione strade".' },
        cpv: { type: 'string', description: 'CPV classification code or numeric prefix, e.g. "45" (construction works), "72000000" (IT services).' },
        buyer: { type: 'string', description: 'Contracting-authority (buyer) name, partial match, Italian spelling, e.g. "Comune di Roma", "ASL Napoli", "Ministero".' },
        province: { type: 'string', description: 'Italian province name as ANAC records it, e.g. "MILANO", "ROMA", "NAPOLI" (case-insensitive exact match).' },
        date_from: { type: 'string', description: `Earliest PUBLISH date, YYYY-MM-DD. Defaults to ${DEFAULT_WINDOW_DAYS} days before date_to.` },
        date_to: { type: 'string', description: 'Latest PUBLISH date, YYYY-MM-DD. Defaults to the newest date in the loaded window (see window_to in any response), which can trail today by months because ANAC publishes monthly bulk files.' },
        limit: { type: ['number', 'string'], description: `Max notices to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}). Newest-first.` },
      },
    },
  },
  {
    name: 'it_tender_detail',
    description:
      'Fetch one ITALIAN public-procurement notice by its CIG (Codice Identificativo Gara — the unique id ANAC assigns every public contract above a minimal threshold) from the ANAC "cig" register. Returns the full record: title, buyer (with tax code), province/region, contract type, amount, lot count, sector, procedure type, realization mode, CPV code/description, publish date, offer deadline, and outcome (aggiudicata/revocata/etc.) with its communication date when ANAC has recorded one. Use after it_tender_search returns a CIG.',
    inputSchema: {
      type: 'object',
      properties: {
        cig: { type: 'string', description: 'The notice\'s CIG, e.g. "B82436559F". Returned by it_tender_search.' },
      },
      required: ['cig'],
    },
  },
];

function noMatch(hint: string, extra?: Record<string, unknown>) {
  return { found: false, reason: 'no_match', hint, ...SOURCE, ...extra };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'it_tender_search': {
        const db = requireDb(args._d1);
        const meta = await getMeta(db);

        const dateToRaw = strArg(args.date_to);
        const dateFromRaw = strArg(args.date_from);
        if (dateToRaw && !isValidDate(dateToRaw)) return { error: 'user_error: date_to must be YYYY-MM-DD.' };
        if (dateFromRaw && !isValidDate(dateFromRaw)) return { error: 'user_error: date_from must be YYYY-MM-DD.' };
        // Default to the END OF THE LOADED WINDOW, not today: ANAC publishes in
        // monthly bulk files and this store can trail today by months (the
        // 2026-10-15 load ends 2025-12-31), so a today-anchored default
        // searched a range holding no data and answered found:false.
        const windowEnd = typeof meta.window_to === 'string' && isValidDate(meta.window_to) ? meta.window_to : null;
        const dateTo = dateToRaw ?? (windowEnd && windowEnd < today() ? windowEnd : today());
        const dateFrom = dateFromRaw ?? addDays(dateTo, -DEFAULT_WINDOW_DAYS);
        if (dateFrom > dateTo) return { error: 'user_error: date_from must be on or before date_to.' };

        const queryRaw = strArg(args.query);
        const terms = queryRaw ? queryRaw.toLowerCase().split(/\s+/).filter(Boolean) : [];
        const cpv = strArg(args.cpv) ?? null;
        const buyer = strArg(args.buyer)?.toLowerCase() ?? null;
        const province = strArg(args.province)?.toLowerCase() ?? null;
        const limit = capped(args.limit);

        const { rows, total } = await searchTenders(db, { terms, cpv, buyer, province, dateFrom, dateTo, limit });

        if (!total) {
          return noMatch(
            `No tender matched between ${dateFrom} and ${dateTo}. This pack holds a recent rolling window (${meta.window_from ?? '?'}..${meta.window_to ?? '?'}), not ANAC's full 2007-present history — try a date range inside that window, or broaden the keyword/buyer/CPV filter.`,
            { date_from: dateFrom, date_to: dateTo, window_from: meta.window_from, window_to: meta.window_to, data_as_of: meta.data_as_of },
          );
        }
        return {
          found: true,
          date_from: dateFrom,
          date_to: dateTo,
          returned: rows.length,
          total_matching: total,
          truncated: total > rows.length,
          tenders: rows.map(shapeSummary),
          window_from: meta.window_from,
          window_to: meta.window_to,
          data_as_of: meta.data_as_of,
          ...SOURCE,
        };
      }

      case 'it_tender_detail': {
        const db = requireDb(args._d1);
        const meta = await getMeta(db);
        const cig = strArg(args.cig);
        if (!cig) return { error: 'it_tender_detail requires "cig" — get one from it_tender_search.' };
        const row = await getTender(db, cig.toUpperCase());
        if (!row) {
          return noMatch(`No tender with CIG "${cig}" in this pack's loaded window (${meta.window_from ?? '?'}..${meta.window_to ?? '?'}). Get a CIG from it_tender_search, or the notice predates/postdates this pack's rolling window.`, {
            window_from: meta.window_from,
            window_to: meta.window_to,
            data_as_of: meta.data_as_of,
          });
        }
        return { found: true, ...shapeFull(row), data_as_of: meta.data_as_of, ...SOURCE };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const { token, body } = splitClassPrefix(raw);
    return {
      error: `${token}italy-tenders: ${body}`,
      retry_hint: 'Retry once; if it persists the ANAC tender store may be temporarily unavailable.',
    };
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
