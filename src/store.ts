/**
 * D1 reads for mcps/italy-tenders.
 *
 * Data: ANAC (Autorità Nazionale Anticorruzione — Italy's national
 * anti-corruption authority, which runs the country's public-procurement
 * notice register) publishes its "cig" dataset (one row per CIG — Codice
 * Identificativo Gara, the unique tender/contract identifier every Italian
 * public contract above a minimal threshold must carry) as MONTHLY CSV zips
 * on its open-data portal, dati.anticorruzione.it (CKAN). There is no
 * search/filter API — datastore_active is false on every resource, and the
 * only live endpoint is a single-CIG lookup with no discovery path. Loaded
 * into a D1 database the gateway hands this pack as `_d1` (pack-manifest
 * "d1Binding": "ITALY_TENDERS_DB") -- never by a deploy. Loader:
 * scripts/italy-tenders/load-data.mjs.
 *
 * Kept OUT of the gateway bundle on purpose — the "cig" monthly CSVs run
 * ~100MB uncompressed / ~115k rows each; any pack dataset over ~200 KB
 * belongs in a store, not an import (fleet #3060).
 *
 * Plain LIKE-based filtering, no FTS5 (reference-d1-fts5-import-trap: an
 * FTS5 virtual table can arrive EMPTY through a chunked import with no
 * error). Search tools require a date range (defaulted, never unbounded) so
 * the LIKE scan runs over a narrowed slice rather than the full table.
 *
 * NOTE on placeholders: D1's local smoke shim mangles NUMBERED placeholders
 * (`?1`) — every statement here uses plain, positional `?` (same convention
 * as mcps/asrs-reports/src/store.ts).
 */

export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'italy-tenders: the ANAC tender store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export const SOURCE = {
  source: 'ANAC (Autorità Nazionale Anticorruzione) — Italian public-procurement notice register, "cig" open dataset',
  source_url: 'https://dati.anticorruzione.it/opendata/dataset/cig',
  licence: 'Creative Commons Attribution-ShareAlike 4.0 (CC-BY-SA-4.0) — see README.md for the quoted terms.',
};

export interface TenderRow {
  cig: string;
  gara_number: string | null;
  title: string | null;
  amount: number | null;
  lot_count: number | null;
  contract_type: string | null;
  status: string | null;
  sector: string | null;
  province: string | null;
  region: string | null;
  publication_date: string | null; // YYYY-MM-DD
  offer_deadline: string | null; // YYYY-MM-DD
  procedure_type: string | null;
  realization_mode: string | null;
  buyer_tax_code: string | null;
  buyer_name: string | null;
  cost_center: string | null;
  cpv_code: string | null;
  cpv_description: string | null;
  outcome: string | null;
  outcome_date: string | null;
  pnrr_flag: number | null;
  publication_year: number | null;
  publication_month: number | null;
}

export function shapeSummary(r: TenderRow) {
  return {
    cig: r.cig,
    title: r.title,
    buyer: r.buyer_name,
    province: r.province,
    region: r.region,
    contract_type: r.contract_type,
    amount_eur: r.amount,
    status: r.status,
    cpv_code: r.cpv_code,
    cpv_description: r.cpv_description,
    published: r.publication_date,
    offer_deadline: r.offer_deadline,
    outcome: r.outcome,
  };
}

export function shapeFull(r: TenderRow) {
  return {
    cig: r.cig,
    gara_number: r.gara_number,
    title: r.title,
    buyer: r.buyer_name,
    buyer_tax_code: r.buyer_tax_code,
    cost_center: r.cost_center,
    province: r.province,
    region: r.region,
    contract_type: r.contract_type,
    amount_eur: r.amount,
    lot_count: r.lot_count,
    sector: r.sector,
    status: r.status,
    procedure_type: r.procedure_type,
    realization_mode: r.realization_mode,
    cpv_code: r.cpv_code,
    cpv_description: r.cpv_description,
    published: r.publication_date,
    offer_deadline: r.offer_deadline,
    outcome: r.outcome,
    outcome_date: r.outcome_date,
    pnrr_pnc_funded: r.pnrr_flag === 1,
  };
}

export function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());
}

export interface SearchFilters {
  terms: string[];
  cpv: string | null;
  buyer: string | null;
  province: string | null;
  dateFrom: string; // YYYY-MM-DD, always set by caller (defaulted)
  dateTo: string; // YYYY-MM-DD, always set by caller (defaulted)
  limit: number;
}

/** Builds WHERE ... args for it_tender_search. The date range is ALWAYS
 *  applied first (it is the one indexed predicate) so every other filter
 *  narrows an already-bounded slice rather than scanning the full table. */
function buildWhere(f: SearchFilters): { clause: string; args: unknown[] } {
  const clauses: string[] = ['publication_date >= ?', 'publication_date <= ?'];
  const args: unknown[] = [f.dateFrom, f.dateTo];
  for (const t of f.terms) {
    clauses.push('(LOWER(title) LIKE ? OR LOWER(cpv_description) LIKE ?)');
    const like = `%${t}%`;
    args.push(like, like);
  }
  if (f.cpv) {
    clauses.push('cpv_code LIKE ?');
    args.push(`${f.cpv}%`);
  }
  if (f.buyer) {
    clauses.push('LOWER(buyer_name) LIKE ?');
    args.push(`%${f.buyer}%`);
  }
  if (f.province) {
    clauses.push('LOWER(province) = ?');
    args.push(f.province);
  }
  return { clause: clauses.join(' AND '), args };
}

export async function searchTenders(db: D1Like, f: SearchFilters): Promise<{ rows: TenderRow[]; total: number }> {
  const { clause, args } = buildWhere(f);
  const countRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM it_tender WHERE ${clause}`)
    .bind(...args)
    .first<{ n: number }>();
  const total = Number(countRow?.n ?? 0);
  if (total === 0) return { rows: [], total: 0 };
  const { results } = await db
    .prepare(`SELECT * FROM it_tender WHERE ${clause} ORDER BY publication_date DESC LIMIT ?`)
    .bind(...args, f.limit)
    .all<TenderRow>();
  return { rows: results, total };
}

export async function getTender(db: D1Like, cig: string): Promise<TenderRow | null> {
  return db.prepare('SELECT * FROM it_tender WHERE cig = ?').bind(cig).first<TenderRow>();
}

export interface Meta {
  data_as_of: string | null;
  window_from: string | null;
  window_to: string | null;
  total_tenders: number;
}

let cachedMeta: Meta | null = null;
export async function getMeta(db: D1Like): Promise<Meta> {
  if (cachedMeta) return cachedMeta;
  const rows = await db.prepare("SELECT key, value FROM it_meta WHERE key IN ('data_as_of','window_from','window_to')").all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const r of rows.results) map[r.key] = r.value;
  const countRow = await db.prepare('SELECT COUNT(*) AS n FROM it_tender').first<{ n: number }>();
  cachedMeta = {
    data_as_of: map.data_as_of ?? null,
    window_from: map.window_from ?? null,
    window_to: map.window_to ?? null,
    total_tenders: Number(countRow?.n ?? 0),
  };
  return cachedMeta;
}
