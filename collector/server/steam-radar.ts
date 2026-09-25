import { ApiError } from "./http.ts";
import type { TenantContext } from "./tenant";
import type { Env } from "./types";
import {
  STEAM_RADAR_DATA_SCHEMA_VERSION,
  type RadarCollectionPayload,
  type RadarLiveEvidence,
  type RadarSearchEvidence,
  type RadarSerpEvidence,
} from "./steam-radar-contract.ts";
import type {
  SteamRadarAction,
  SteamRadarItem,
  SteamRadarKind,
  SteamRadarResponse,
  SteamRadarSerpResult,
  SteamRadarTrendPoint,
} from "../src/types/steamRadar";

const STEAM_SEARCH_URL =
  "https://store.steampowered.com/search/results/?query&start=0&count=50&sort_by=Released_DESC&supportedlang=english&infinite=1&json=1";
const STEAM_SEARCH_PAGE_URL =
  "https://store.steampowered.com/search/?sort_by=Released_DESC&supportedlang=english";
const STEAM_BROWSER_HEADERS = {
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  Referer: STEAM_SEARCH_PAGE_URL,
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-origin",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  "X-Requested-With": "XMLHttpRequest",
} as const;
const INTENT_TERMS = [
  "wiki", "guide", "walkthrough", "build", "tier list", "map", "boss", "item",
  "weapon", "codes", "recipe", "quest", "class", "achievement", "calculator", "planner",
];
const TITLE_INTENT_TERMS = [
  "simulator", "simulation", "survival", "puzzle", "escape", "horror", "tycoon",
  "manager", "idle", "craft", "quest", "mystery", "strategy",
];
// 1 discovery + 12×(players+reviews) + 5×(3 suggest+1 SERP) = 45 subrequests,
// stays below the common Cloudflare Workers free-tier limit of 50.
const ENRICH_LIMIT = 12;
const SEARCH_LIMIT = 5;

interface SnapshotRow {
  app_id: string;
  captured_at: string;
  current_players: number | null;
  review_total: number | null;
  opportunity_score: number;
}

interface GameRow {
  app_id: string;
  title: string;
  store_url: string;
  capsule_url: string | null;
  release_date: string | null;
  kind: SteamRadarKind;
  price_label: string;
  discount_percent: number;
  tag_ids_json: string;
  first_seen_at: string;
  last_seen_at: string;
  source_json: string | null;
}

interface SearchRow {
  app_id: string;
  queries_json: string;
  matched_intents_json: string;
  search_score: number | null;
  captured_at: string;
}

interface SerpRow {
  app_id: string;
  provider: string;
  results_json: string;
  competitor_count: number | null;
  serp_score: number | null;
  captured_at: string;
}

interface LiveEvidence {
  currentPlayers: number | null;
  reviewTotal: number | null;
  reviewPositive: number | null;
  reviewNegative: number | null;
}

export interface CollectSteamRadarDataOptions {
  now?: Date;
  scheduledAt?: Date;
  collectorVersion?: string;
  serperApiKey?: string;
  includeSearchEnrichment?: boolean;
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: " ", ndash: "–", mdash: "—",
  };
  return value
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity)
    .replace(/<br\s*\/?\s*>/gi, " · ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getAttr(source: string, name: string): string | null {
  const match = source.match(new RegExp(`${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? decodeHtml(match[2]) : null;
}

function innerText(block: string, className: string): string {
  const match = block.match(
    new RegExp(`<[^>]+class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/[^>]+>`, "i"),
  );
  return match ? decodeHtml(match[1]) : "";
}

function inferKind(title: string): SteamRadarKind {
  const value = title.toLowerCase();
  if (/\bsoundtrack\b|\boriginal score\b/.test(value)) return "soundtrack";
  if (/\bdemo\b|\bprologue\b/.test(value)) return "demo";
  if (/\bdlc\b|\bexpansion\b|\bseason pass\b|\bcontent pack\b|\bskin pack\b/.test(value)) return "dlc";
  return title ? "game" : "unknown";
}

function parseReleaseDate(value: string): string | null {
  if (!value || /coming soon|to be announced/i.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function daysFrom(dateIso: string | null, now: Date): number | null {
  if (!dateIso) return null;
  return Math.floor((now.getTime() - new Date(dateIso).getTime()) / 86_400_000);
}

function baseScore(input: { title: string; daysSinceRelease: number | null; kind: SteamRadarKind; reviewLabel: string | null; isFree: boolean; discountPercent: number }): { score: number; signals: string[] } {
  let score = 0;
  const signals: string[] = [];
  const days = input.daysSinceRelease;
  if (days !== null) {
    if (days >= -1 && days <= 1) { score += 30; signals.push("24 小时发布窗口"); }
    else if (days <= 3) { score += 26; signals.push("3 天内新游"); }
    else if (days <= 7) { score += 20; signals.push("7 天内新游"); }
    else if (days <= 14) score += 12;
    else if (days <= 30) score += 6;
  }
  if (input.kind === "game") score += 20;
  if (input.kind === "demo") score += 4;
  if (input.kind === "dlc" || input.kind === "soundtrack") score -= 18;
  const matched = TITLE_INTENT_TERMS.filter((term) => input.title.toLowerCase().includes(term));
  if (matched.length) { score += Math.min(20, 12 + matched.length * 4); signals.push(`攻略意图：${matched.slice(0, 2).join(" / ")}`); }
  if (input.reviewLabel) { score += 12; signals.push("已有评测证据"); }
  if (input.isFree) { score += 8; signals.push("免费游玩"); }
  else if (input.discountPercent > 0) { score += Math.min(8, Math.ceil(input.discountPercent / 10) * 2); signals.push(`首发折扣 ${input.discountPercent}%`); }
  return { score: Math.max(0, Math.min(100, score)), signals };
}

function emptyDerived(score: number): Pick<SteamRadarItem,
  "currentPlayers" | "playerDelta3h" | "reviewTotal" | "reviewDelta6h" | "evidenceCoverage" |
  "siteScore" | "confidenceScore" | "momentumScore" | "searchDemandScore" |
  "serpOpportunityScore" | "competitorCount" | "action" | "confidence" | "reasonCodes" |
  "missingEvidence" | "searchQueries" | "matchedIntents" | "serpProvider" | "serpResults" |
  "trend14d" | "nextStep" | "watched"> {
  return {
    currentPlayers: null, playerDelta3h: null, reviewTotal: null, reviewDelta6h: null,
    evidenceCoverage: 20, siteScore: null, confidenceScore: 20, momentumScore: null,
    searchDemandScore: null, serpOpportunityScore: null, competitorCount: null,
    action: score >= 65 ? "validate" : score >= 45 ? "watch" : "skip",
    confidence: "low", reasonCodes: [], missingEvidence: ["PLAYER_HISTORY_3H", "SEARCH", "SERP"],
    searchQueries: [], matchedIntents: [], serpProvider: null, serpResults: [], trend14d: [],
    nextStep: "继续采集玩家历史、搜索与 SERP 证据", watched: false,
  };
}

export function parseSteamSearchHtml(html: string, now = new Date()): SteamRadarItem[] {
  const rows = html.match(/<a\b(?=[^>]*class=["'][^"']*\bsearch_result_row\b)[\s\S]*?<\/a>/gi) ?? [];
  return rows.flatMap((row): SteamRadarItem[] => {
    const openingTag = row.match(/^<a\b[\s\S]*?>/i)?.[0] ?? "";
    const appId = getAttr(openingTag, "data-ds-appid");
    const title = innerText(row, "title");
    if (!appId || !title) return [];
    const releaseDate = innerText(row, "search_released");
    const releaseDateIso = parseReleaseDate(releaseDate);
    const imgTag = row.match(/<img\b[^>]*>/i)?.[0] ?? "";
    const priceBlock = row.match(/class=["'][^"']*search_price_discount_combined[^"']*["'][^>]*>/i)?.[0] ?? "";
    const discountBlock = row.match(/class=["'][^"']*discount_block[^"']*["'][^>]*>/i)?.[0] ?? "";
    const reviewTag = row.match(/<span\b[^>]*class=["'][^"']*search_review_summary[^"']*["'][^>]*>/i)?.[0] ?? "";
    const priceFinal = Number(getAttr(priceBlock, "data-price-final") ?? NaN);
    const discountPercent = Number(getAttr(discountBlock, "data-discount") ?? 0);
    const platforms = Array.from(row.matchAll(/class=["'][^"']*platform_img\s+(win|mac|linux)[^"']*["']/gi)).map((match) => match[1].toLowerCase());
    let tagIds: number[] = [];
    try { const parsed = JSON.parse(getAttr(openingTag, "data-ds-tagids") ?? "[]"); if (Array.isArray(parsed)) tagIds = parsed.filter(Number.isInteger); } catch { tagIds = []; }
    const base = {
      appId, title, url: `https://store.steampowered.com/app/${appId}/`, capsuleUrl: getAttr(imgTag, "src"),
      releaseDate, releaseDateIso, daysSinceRelease: daysFrom(releaseDateIso, now),
      platforms: [...new Set(platforms)], tagIds, kind: inferKind(title),
      priceLabel: innerText(row, "discount_final_price") || (priceFinal === 0 ? "Free" : "—"),
      isFree: priceFinal === 0, discountPercent: Number.isFinite(discountPercent) ? discountPercent : 0,
      reviewLabel: getAttr(reviewTag, "data-tooltip-html"),
    };
    const initial = baseScore(base);
    return [{ ...base, score: initial.score, signals: initial.signals, keywordIdeas: keywordIdeas(title), ...emptyDerived(initial.score) }];
  });
}

function keywordIdeas(title: string): string[] {
  return ["wiki", "guide", "walkthrough", "best build", "tier list", "map", "boss guide", "items", "weapons", "codes", "achievements", "calculator"].map((suffix) => `${title} ${suffix}`);
}

async function fetchWithTimeout(fetcher: typeof fetch, url: string, init: RequestInit = {}, timeoutMs = 7_000): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetcher(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

async function fetchSteamSearch(fetcher: typeof fetch): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchWithTimeout(fetcher, STEAM_SEARCH_URL, { headers: STEAM_BROWSER_HEADERS });
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { results_html?: unknown };
      if (typeof payload.results_html !== "string") throw new Error("invalid payload");
      return payload.results_html;
    } catch {
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      }
    }
  }
  throw new ApiError(502, "steam_unavailable", "Steam 数据源暂时不可用，请稍后重试");
}

async function fetchLiveEvidence(fetcher: typeof fetch, appId: string): Promise<LiveEvidence> {
  const [players, reviews] = await Promise.allSettled([
    fetchWithTimeout(fetcher, `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`).then((r) => r.json()) as Promise<any>,
    fetchWithTimeout(fetcher, `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=0`).then((r) => r.json()) as Promise<any>,
  ]);
  const playerCount = players.status === "fulfilled" ? Number(players.value?.response?.player_count) : NaN;
  const summary = reviews.status === "fulfilled" ? reviews.value?.query_summary : null;
  return {
    currentPlayers: Number.isFinite(playerCount) ? playerCount : null,
    reviewTotal: Number.isFinite(Number(summary?.total_reviews)) ? Number(summary.total_reviews) : null,
    reviewPositive: Number.isFinite(Number(summary?.total_positive)) ? Number(summary.total_positive) : null,
    reviewNegative: Number.isFinite(Number(summary?.total_negative)) ? Number(summary.total_negative) : null,
  };
}

async function fetchSearchEvidence(fetcher: typeof fetch, title: string): Promise<{ queries: string[]; matchedIntents: string[]; score: number }> {
  const seeds = [title, `${title} guide`, `${title} wiki`];
  const results = await Promise.allSettled(seeds.map(async (seed) => {
    const response = await fetchWithTimeout(fetcher, `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(seed)}`);
    const body = (await response.json()) as unknown;
    return Array.isArray(body) && Array.isArray(body[1]) ? body[1].filter((value): value is string => typeof value === "string") : [];
  }));
  const queries = [...new Set(results.flatMap((result) => result.status === "fulfilled" ? result.value : []))].slice(0, 40);
  const normalized = queries.join(" ").toLowerCase();
  const matchedIntents = INTENT_TERMS.filter((term) => normalized.includes(term));
  const score = Math.min(100, Math.round(queries.length * 2.5 + matchedIntents.length * 12));
  return { queries, matchedIntents, score };
}

function classifyDomain(domain: string): SteamRadarSerpResult["category"] {
  if (/steampowered|steamcommunity|steamdb/.test(domain)) return "steam";
  if (/youtube|reddit|x\.com|twitter|facebook|tiktok/.test(domain)) return "social";
  if (/fandom|wiki|wikigg/.test(domain)) return "wiki";
  if (/ign|gamespot|pcgamer|kotaku|polygon|eurogamer|rockpapershotgun/.test(domain)) return "big-media";
  if (/game8|gamerant|thegamer|progameguides|gamepressure|sportskeeda/.test(domain)) return "specialist";
  return "other";
}

function normalizeSerpResults(raw: Array<{ title?: unknown; link?: unknown }>): SteamRadarSerpResult[] {
  const seen = new Set<string>();
  return raw.flatMap((entry): SteamRadarSerpResult[] => {
    if (typeof entry.link !== "string" || typeof entry.title !== "string") return [];
    try {
      const url = new URL(decodeHtml(entry.link));
      const domain = url.hostname.replace(/^www\./, "");
      if (seen.has(url.href) || domain.endsWith("brave.com")) return [];
      seen.add(url.href);
      return [{ position: seen.size, title: decodeHtml(entry.title), url: url.href, domain, category: classifyDomain(domain) }];
    } catch { return []; }
  }).slice(0, 10);
}

async function fetchSerpEvidence(fetcher: typeof fetch, env: Env, title: string): Promise<{ provider: string; results: SteamRadarSerpResult[]; competitorCount: number; score: number }> {
  let provider = "Brave Web (best-effort)";
  let results: SteamRadarSerpResult[] = [];
  if (env.SERPER_API_KEY) {
    provider = "Serper / Google";
    const response = await fetchWithTimeout(fetcher, "https://google.serper.dev/search", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": env.SERPER_API_KEY },
      body: JSON.stringify({ q: `${title} guide`, gl: "us", hl: "en", num: 10 }),
    });
    if (response.ok) {
      const body = (await response.json()) as { organic?: Array<{ title?: unknown; link?: unknown }> };
      results = normalizeSerpResults(body.organic ?? []);
    }
  } else {
    const response = await fetchWithTimeout(fetcher, `https://search.brave.com/search?q=${encodeURIComponent(`${title} guide`)}&source=web`, { headers: { "User-Agent": "Mozilla/5.0 (compatible; SiteLaunchHub/1.0)" } });
    if (response.ok) {
      const html = await response.text();
      const raw: Array<{ title: string; link: string }> = [];
      for (const match of html.matchAll(/<a[^>]+href="(https?:\/\/[^"#]+)"[^>]*>[\s\S]{0,1800}?class="title search-snippet-title[^"']*"[^>]*title="([^"]+)"/gi)) raw.push({ link: match[1], title: match[2] });
      results = normalizeSerpResults(raw);
    }
  }
  const competitorCount = results.filter((result) => ["wiki", "specialist", "other"].includes(result.category)).length;
  const saturation = results.filter((result) => result.category === "wiki").length;
  return { provider, results, competitorCount, score: Math.max(0, Math.min(100, 100 - competitorCount * 11 - saturation * 7)) };
}

function safeArray<T>(value: string | null | undefined): T[] {
  try { const parsed = JSON.parse(value ?? "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function hourBucket(date: Date): string { return date.toISOString().slice(0, 13); }
function isFresh(value: string, hours: number, now: Date): boolean { return now.getTime() - new Date(value).getTime() < hours * 3_600_000; }

/**
 * 与 D1 解耦的采集入口，供 GitHub Actions/CLI 使用。
 * 只产生可序列化、可校验的公开数据，不读取或写入租户状态。
 */
export async function collectSteamRadarData(
  fetcher: typeof fetch = fetch,
  options: CollectSteamRadarDataOptions = {},
): Promise<RadarCollectionPayload> {
  const now = options.now ?? new Date();
  const scheduledAt = options.scheduledAt ?? now;
  const html = await fetchSteamSearch(fetcher);
  const games = parseSteamSearchHtml(html, now);
  if (!games.length) {
    throw new ApiError(502, "steam_empty_results", "Steam 返回了空结果或无法识别的页面结构");
  }

  const candidates = games
    .filter((item) => item.kind === "game")
    .sort((a, b) => b.score - a.score);
  const live = new Map<string, RadarLiveEvidence>();
  for (let offset = 0; offset < Math.min(ENRICH_LIMIT, candidates.length); offset += 5) {
    const batch = candidates.slice(offset, offset + 5);
    const evidence = await Promise.all(batch.map((item) => fetchLiveEvidence(fetcher, item.appId)));
    batch.forEach((item, index) => live.set(item.appId, evidence[index]));
  }

  const search = new Map<string, RadarSearchEvidence>();
  const serp = new Map<string, RadarSerpEvidence>();
  const includeSearchEnrichment = options.includeSearchEnrichment ?? true;
  const evidenceCandidates = includeSearchEnrichment ? candidates.slice(0, SEARCH_LIMIT) : [];
  await Promise.all(evidenceCandidates.map(async (item) => {
    const searchResult = await fetchSearchEvidence(fetcher, item.title);
    search.set(item.appId, searchResult);
    try {
      const result = await fetchSerpEvidence(fetcher, { SERPER_API_KEY: options.serperApiKey } as Env, item.title);
      serp.set(item.appId, {
        query: `${item.title} guide`,
        provider: result.provider,
        results: result.results,
        competitorCount: result.competitorCount,
        score: result.results.length ? result.score : null,
      });
    } catch {
      // SERP 是可选证据；失败保持 null，由状态和 LKG 处理，不能伪造空竞争。
    }
  }));

  const items = games.map((game) => {
    const liveEvidence = live.get(game.appId) ?? null;
    const searchEvidence = search.get(game.appId) ?? null;
    const serpEvidence = serp.get(game.appId) ?? null;
    const has = [
      game.releaseDateIso !== null,
      liveEvidence?.currentPlayers != null,
      liveEvidence?.reviewTotal != null,
      searchEvidence !== null,
      serpEvidence?.score != null,
    ];
    const evidenceCoverage = Math.round(has.filter(Boolean).length / has.length * 100);
    const siteScore = searchEvidence && serpEvidence?.score !== null && serpEvidence?.score !== undefined
      ? Math.round(game.score * .3 + 40 * .2 + searchEvidence.score * .25 + serpEvidence.score * .25)
      : null;
    const hydrated = {
      ...game,
      currentPlayers: liveEvidence?.currentPlayers ?? null,
      reviewTotal: liveEvidence?.reviewTotal ?? null,
      evidenceCoverage,
      searchDemandScore: searchEvidence?.score ?? null,
      serpOpportunityScore: serpEvidence?.score ?? null,
      competitorCount: serpEvidence?.competitorCount ?? null,
      siteScore,
      score: siteScore ?? game.score,
      searchQueries: searchEvidence?.queries ?? [],
      matchedIntents: searchEvidence?.matchedIntents ?? [],
      serpProvider: serpEvidence?.provider ?? null,
      serpResults: serpEvidence?.results ?? [],
    };
    return { game: hydrated, live: liveEvidence, search: searchEvidence, serp: serpEvidence };
  });

  const liveValues = [...live.values()];
  const liveComplete = liveValues.length > 0 && liveValues.every((value) => (
    value.currentPlayers !== null && value.reviewTotal !== null
  ));
  return {
    schemaVersion: STEAM_RADAR_DATA_SCHEMA_VERSION,
    runId: `steam-radar:${scheduledAt.toISOString().slice(0, 13)}`,
    scheduledAt: scheduledAt.toISOString(),
    collectedAt: now.toISOString(),
    collectorVersion: options.collectorVersion ?? "local",
    source: {
      name: "Steam Search",
      url: STEAM_SEARCH_URL,
      scope: "Steam 英文区最新发布，最多 50 条",
    },
    providerStatus: {
      steamSearch: "FRESH",
      steamLiveEvidence: liveComplete ? "FRESH" : liveValues.length ? "PARTIAL" : "MISSING",
      googleSuggest: includeSearchEnrichment
        ? search.size === evidenceCandidates.length ? "FRESH" : search.size ? "PARTIAL" : "MISSING"
        : "CACHED",
      serp: includeSearchEnrichment
        ? serp.size === evidenceCandidates.length ? "FRESH" : serp.size ? "PARTIAL" : "MISSING"
        : "CACHED",
    },
    items,
  };
}

async function loadExistingEvidence(env: Env): Promise<{ search: Map<string, SearchRow>; serp: Map<string, SerpRow> }> {
  const [searchRows, serpRows] = await Promise.all([
    env.DB.prepare(`SELECT * FROM steam_radar_search_evidence`).all<SearchRow>(),
    env.DB.prepare(`SELECT * FROM steam_radar_serp_evidence`).all<SerpRow>(),
  ]);
  return { search: new Map(searchRows.results.map((row) => [row.app_id, row])), serp: new Map(serpRows.results.map((row) => [row.app_id, row])) };
}

async function persistCollection(env: Env, items: SteamRadarItem[], live: Map<string, LiveEvidence>, search: Map<string, SearchRow>, serp: Map<string, SerpRow>, now: Date): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  const currentAppIds = new Set(items.map((item) => item.appId));
  for (const item of items) {
    statements.push(env.DB.prepare(`INSERT INTO steam_radar_games
      (app_id,title,store_url,capsule_url,release_date,kind,price_label,discount_percent,tag_ids_json,first_seen_at,last_seen_at,source_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(app_id) DO UPDATE SET title=excluded.title,store_url=excluded.store_url,
      capsule_url=excluded.capsule_url,release_date=excluded.release_date,kind=excluded.kind,price_label=excluded.price_label,
      discount_percent=excluded.discount_percent,tag_ids_json=excluded.tag_ids_json,last_seen_at=excluded.last_seen_at,
      source_json=excluded.source_json`)
      .bind(item.appId, item.title, item.url, item.capsuleUrl, item.releaseDateIso, item.kind, item.priceLabel, item.discountPercent, JSON.stringify(item.tagIds), now.toISOString(), now.toISOString(), JSON.stringify(item)));
  }
  for (const [appId, evidence] of live) {
    const item = items.find((candidate) => candidate.appId === appId)!;
    statements.push(env.DB.prepare(`INSERT INTO steam_radar_snapshots
      (app_id,captured_hour,captured_at,current_players,review_total,review_positive,review_negative,opportunity_score)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(app_id,captured_hour) DO UPDATE SET captured_at=excluded.captured_at,
      current_players=excluded.current_players,review_total=excluded.review_total,review_positive=excluded.review_positive,
      review_negative=excluded.review_negative,opportunity_score=excluded.opportunity_score`)
      .bind(appId, hourBucket(now), now.toISOString(), evidence.currentPlayers, evidence.reviewTotal, evidence.reviewPositive, evidence.reviewNegative, item.score));
  }
  for (const row of search.values()) if (currentAppIds.has(row.app_id)) statements.push(env.DB.prepare(`INSERT INTO steam_radar_search_evidence
    (app_id,queries_json,matched_intents_json,search_score,captured_at) VALUES (?,?,?,?,?)
    ON CONFLICT(app_id) DO UPDATE SET queries_json=excluded.queries_json,matched_intents_json=excluded.matched_intents_json,
    search_score=excluded.search_score,captured_at=excluded.captured_at`).bind(row.app_id, row.queries_json, row.matched_intents_json, row.search_score, row.captured_at));
  for (const row of serp.values()) if (currentAppIds.has(row.app_id)) statements.push(env.DB.prepare(`INSERT INTO steam_radar_serp_evidence
    (app_id,query,provider,results_json,competitor_count,serp_score,captured_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(app_id) DO UPDATE SET query=excluded.query,provider=excluded.provider,results_json=excluded.results_json,
    competitor_count=excluded.competitor_count,serp_score=excluded.serp_score,captured_at=excluded.captured_at`)
    .bind(row.app_id, `${items.find((item) => item.appId === row.app_id)?.title ?? ""} guide`, row.provider, row.results_json, row.competitor_count, row.serp_score, row.captured_at));
  if (statements.length) await env.DB.batch(statements);
}

async function loadHistory(env: Env, tenantId: string, since: string): Promise<{ snapshots: Map<string, SnapshotRow[]>; watched: Set<string> }> {
  const [snapshots, watchRows] = await Promise.all([
    env.DB.prepare(`SELECT app_id,captured_at,current_players,review_total,opportunity_score FROM steam_radar_snapshots WHERE captured_at >= ? ORDER BY captured_at ASC`).bind(since).all<SnapshotRow>(),
    env.DB.prepare(`SELECT app_id FROM steam_radar_watchlist WHERE tenant_id = ?`).bind(tenantId).all<{ app_id: string }>(),
  ]);
  const grouped = new Map<string, SnapshotRow[]>();
  for (const row of snapshots.results) grouped.set(row.app_id, [...(grouped.get(row.app_id) ?? []), row]);
  return { snapshots: grouped, watched: new Set(watchRows.results.map((row) => row.app_id)) };
}

function historicalDelta(rows: SnapshotRow[], field: "current_players" | "review_total", hours: number, now: Date): number | null {
  const latest = [...rows].reverse().find((row) => row[field] !== null);
  const cutoff = now.getTime() - hours * 3_600_000;
  const baseline = [...rows].reverse().find((row) => row[field] !== null && new Date(row.captured_at).getTime() <= cutoff);
  return latest && baseline ? (latest[field] as number) - (baseline[field] as number) : null;
}

function enrichItem(item: SteamRadarItem, rows: SnapshotRow[], search: SearchRow | undefined, serp: SerpRow | undefined, watched: boolean, now: Date): SteamRadarItem {
  const latest = rows.at(-1);
  const playerDelta3h = historicalDelta(rows, "current_players", 3, now);
  const reviewDelta6h = historicalDelta(rows, "review_total", 6, now);
  const searchScore = search?.search_score ?? null;
  const serpScore = serp?.serp_score ?? null;
  const has = [item.releaseDateIso !== null, latest?.current_players != null, latest?.review_total != null, searchScore !== null, serpScore !== null];
  const evidenceCoverage = Math.round(has.filter(Boolean).length / has.length * 100);
  const momentumScore = latest?.current_players == null || playerDelta3h === null ? null : Math.max(0, Math.min(100,
    45 + Math.min(35, Math.max(-30, playerDelta3h * 2)) + Math.min(20, Math.max(0, (reviewDelta6h ?? 0) * 4)),
  ));
  const siteScore = searchScore === null || serpScore === null ? null : Math.round(
    item.score * .3 + (momentumScore ?? 40) * .2 + searchScore * .25 + serpScore * .25,
  );
  const confidenceScore = Math.round(evidenceCoverage * .75 + Math.min(25, rows.length * 5));
  const score = siteScore ?? item.score;
  const action: SteamRadarAction = siteScore !== null && siteScore >= 72 && confidenceScore >= 60
    ? "build" : score >= 60 ? "validate" : score >= 40 ? "watch" : "skip";
  const missingEvidence = [
    playerDelta3h === null ? "PLAYER_HISTORY_3H" : null,
    searchScore === null ? "SEARCH" : null,
    serpScore === null ? "SERP" : null,
  ].filter((value): value is string => value !== null);
  const signals = [...item.signals];
  if (playerDelta3h !== null && playerDelta3h > 0) signals.push(`玩家 3h +${playerDelta3h}`);
  if (reviewDelta6h !== null && reviewDelta6h > 0) signals.push(`评论 6h +${reviewDelta6h}`);
  if ((searchScore ?? 0) >= 45) signals.push("搜索意图出现");
  if (serpScore !== null) signals.push("SERP 已验证");
  const nextStep = action === "build" ? "进入项目验证并准备建站" : action === "validate" ? "核验搜索体量与竞品内容" : action === "watch" ? "持续采集 3h / 6h 动量" : "暂不投入，等待新信号";
  const trend14d: SteamRadarTrendPoint[] = rows.map((row) => ({ at: row.captured_at, players: row.current_players, reviews: row.review_total, score: row.opportunity_score }));
  return {
    ...item, score, siteScore, currentPlayers: latest?.current_players ?? null, playerDelta3h,
    reviewTotal: latest?.review_total ?? null, reviewDelta6h, evidenceCoverage, confidenceScore,
    momentumScore, searchDemandScore: searchScore, serpOpportunityScore: serpScore,
    competitorCount: serp?.competitor_count ?? null, action,
    confidence: confidenceScore >= 75 ? "high" : confidenceScore >= 45 ? "medium" : "low",
    signals: [...new Set(signals)], reasonCodes: signals.map((signal) => signal.toUpperCase().replace(/[^A-Z0-9]+/g, "_")).filter(Boolean),
    missingEvidence, searchQueries: safeArray<string>(search?.queries_json), matchedIntents: safeArray<string>(search?.matched_intents_json),
    serpProvider: serp?.provider ?? null, serpResults: safeArray<SteamRadarSerpResult>(serp?.results_json),
    trend14d, nextStep, watched,
  };
}

function itemFromGameRow(row: GameRow, now: Date): SteamRadarItem {
  if (row.source_json) {
    try {
      const parsed = JSON.parse(row.source_json) as SteamRadarItem;
      if (parsed && parsed.appId === row.app_id && typeof parsed.title === "string") return parsed;
    } catch {
      // 旧数据或损坏的 source_json 回退到结构化列，避免整个榜单不可读。
    }
  }
  const releaseDateIso = row.release_date;
  const base = {
    appId: row.app_id,
    title: row.title,
    url: row.store_url,
    capsuleUrl: row.capsule_url,
    releaseDate: releaseDateIso ?? "",
    releaseDateIso,
    daysSinceRelease: daysFrom(releaseDateIso, now),
    platforms: [],
    tagIds: safeArray<number>(row.tag_ids_json),
    kind: row.kind,
    priceLabel: row.price_label,
    isFree: row.price_label.toLowerCase() === "free",
    discountPercent: row.discount_percent,
    reviewLabel: null,
  };
  const initial = baseScore(base);
  return { ...base, score: initial.score, signals: initial.signals, keywordIdeas: keywordIdeas(row.title), ...emptyDerived(initial.score) };
}

/** 只读 D1 的页面查询；不会访问 Steam、Suggest 或 SERP。 */
export async function readSteamRadar(ctx: TenantContext): Promise<SteamRadarResponse> {
  const now = new Date();
  const latest = await ctx.env.DB.prepare(`SELECT MAX(last_seen_at) AS last_seen_at FROM steam_radar_games`)
    .first<{ last_seen_at: string | null }>();
  const latestSeenAt = latest?.last_seen_at ?? null;
  const gameRows = latestSeenAt
    ? await ctx.env.DB.prepare(`SELECT * FROM steam_radar_games WHERE last_seen_at = ? ORDER BY title ASC`).bind(latestSeenAt).all<GameRow>()
    : { results: [] as GameRow[] };
  const items = gameRows.results.map((row) => itemFromGameRow(row, now));
  const existing = await loadExistingEvidence(ctx.env);
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const history = await loadHistory(ctx.env, ctx.tenantId, since);
  const enriched = items.map((item) => enrichItem(
    item,
    history.snapshots.get(item.appId) ?? [],
    existing.search.get(item.appId),
    existing.serp.get(item.appId),
    history.watched.has(item.appId),
    now,
  ));
  const providers = new Set<string>(["Steam Search", "Steam Current Players", "Steam Reviews", "Google Suggest"]);
  for (const evidence of existing.serp.values()) if (evidence.provider) providers.add(evidence.provider);
  return {
    source: {
      name: "Steam Search",
      url: STEAM_SEARCH_URL,
      scope: "Steam 英文区最新发布，最多 50 条",
      providers: [...providers],
    },
    fetchedAt: latestSeenAt ?? now.toISOString(),
    total: enriched.length,
    historyStatus: [...history.snapshots.values()].some((rows) => rows.length >= 2) ? "ready" : "collecting",
    scoring: {
      version: "steam-radar-v2",
      factors: ["新鲜度与游戏类型 0–50", "玩家/评论动量 0–100", "搜索意图 0–100", "SERP 可进入度 0–100", "证据覆盖与历史置信度 0–100"],
    },
    limitations: [
      "页面只读取最近成功导入的 D1 数据，不会因刷新页面访问外部数据源。",
      "Google Suggest 是相对意图证据，不等于绝对搜索量。",
      "3h、6h 与 14 天趋势来自本项目实际保存的小时快照。",
    ],
    items: enriched,
  };
}

export async function getSteamRadar(ctx: TenantContext, fetcher: typeof fetch = fetch, force = false): Promise<SteamRadarResponse> {
  const now = new Date();
  const html = await fetchSteamSearch(fetcher);
  const items = parseSteamSearchHtml(html, now);
  const existing = await loadExistingEvidence(ctx.env);
  const candidates = items.filter((item) => item.kind === "game").sort((a, b) => b.score - a.score);
  const live = new Map<string, LiveEvidence>();
  for (let offset = 0; offset < Math.min(ENRICH_LIMIT, candidates.length); offset += 5) {
    const batch = candidates.slice(offset, offset + 5);
    const evidence = await Promise.all(batch.map((item) => fetchLiveEvidence(fetcher, item.appId)));
    batch.forEach((item, index) => live.set(item.appId, evidence[index]));
  }
  const evidenceCandidates = candidates.slice(0, SEARCH_LIMIT);
  await Promise.all(evidenceCandidates.map(async (item) => {
    const currentSearch = existing.search.get(item.appId);
    if (force || !currentSearch || !isFresh(currentSearch.captured_at, 24, now)) {
      const result = await fetchSearchEvidence(fetcher, item.title);
      existing.search.set(item.appId, { app_id: item.appId, queries_json: JSON.stringify(result.queries), matched_intents_json: JSON.stringify(result.matchedIntents), search_score: result.score, captured_at: now.toISOString() });
    }
    const currentSerp = existing.serp.get(item.appId);
    if (force || !currentSerp || !isFresh(currentSerp.captured_at, 24, now)) {
      try {
        const result = await fetchSerpEvidence(fetcher, ctx.env, item.title);
        existing.serp.set(item.appId, { app_id: item.appId, provider: result.provider, results_json: JSON.stringify(result.results), competitor_count: result.competitorCount, serp_score: result.results.length ? result.score : null, captured_at: now.toISOString() });
      } catch { /* keep the previous verified SERP instead of fabricating */ }
    }
  }));
  await persistCollection(ctx.env, items, live, existing.search, existing.serp, now);
  const since = new Date(now.getTime() - 14 * 86_400_000).toISOString();
  const history = await loadHistory(ctx.env, ctx.tenantId, since);
  const enriched = items.map((item) => enrichItem(item, history.snapshots.get(item.appId) ?? [], existing.search.get(item.appId), existing.serp.get(item.appId), history.watched.has(item.appId), now));
  return {
    source: { name: "Steam Search", url: STEAM_SEARCH_URL, scope: "Steam 英文区最新发布，最多 50 条", providers: ["Steam Search", "Steam Current Players", "Steam Reviews", "Google Suggest", ctx.env.SERPER_API_KEY ? "Serper / Google" : "Brave Web best-effort"] },
    fetchedAt: now.toISOString(), total: enriched.length,
    historyStatus: [...history.snapshots.values()].some((rows) => rows.length >= 2) ? "ready" : "collecting",
    scoring: { version: "steam-radar-v2", factors: ["新鲜度与游戏类型 0–50", "玩家/评论动量 0–100", "搜索意图 0–100", "SERP 可进入度 0–100", "证据覆盖与历史置信度 0–100"] },
    limitations: ["Google Suggest 是相对意图证据，不等于绝对搜索量；未配置付费关键词数据源时不会声称已验证市场体量。", "3h、6h 与 14 天趋势来自本项目自己的 D1 快照，首次启用需要等待采集窗口形成。", ctx.env.SERPER_API_KEY ? "SERP 使用 Serper 提供的 Google 结果。" : "未配置 SERPER_API_KEY，SERP 使用 Brave Web best-effort 结果并明确标注来源。"],
    items: enriched,
  };
}

export async function setSteamRadarWatch(ctx: TenantContext, appId: string, watched: boolean): Promise<{ appId: string; watched: boolean }> {
  const exists = await ctx.env.DB.prepare(`SELECT app_id FROM steam_radar_games WHERE app_id = ?`).bind(appId).first();
  if (!exists) throw new ApiError(404, "radar_game_not_found", "雷达游戏不存在");
  if (watched) await ctx.env.DB.prepare(`INSERT INTO steam_radar_watchlist (tenant_id,app_id,created_at) VALUES (?,?,?) ON CONFLICT(tenant_id,app_id) DO NOTHING`).bind(ctx.tenantId, appId, new Date().toISOString()).run();
  else await ctx.env.DB.prepare(`DELETE FROM steam_radar_watchlist WHERE tenant_id = ? AND app_id = ?`).bind(ctx.tenantId, appId).run();
  return { appId, watched };
}

/** 无会话的后台采集入口；只写全局证据，不读取或写入任何真实租户观察状态。 */
export async function collectSteamRadar(env: Env, fetcher: typeof fetch = fetch): Promise<{ collected: number; fetchedAt: string; historyStatus: string }> {
  const response = await getSteamRadar({
    env,
    request: new Request("https://collector.invalid/api/radar/collect"),
    userId: "__radar_collector__",
    userEmail: "collector@localhost.invalid",
    tenantId: "__radar_collector__",
    role: "system",
    memberId: "__radar_collector__",
  }, fetcher, true);
  return { collected: response.total, fetchedAt: response.fetchedAt, historyStatus: response.historyStatus };
}
