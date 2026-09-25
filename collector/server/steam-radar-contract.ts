import type { SteamRadarItem, SteamRadarSerpResult } from "../src/types/steamRadar.ts";

export const STEAM_RADAR_DATA_SCHEMA_VERSION = "steam-radar-data-v1";
export const STEAM_RADAR_MAX_ITEMS = 50;
export const STEAM_RADAR_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export type RadarProviderState = "FRESH" | "PARTIAL" | "MISSING" | "CACHED" | "ERROR";

export interface RadarLiveEvidence {
  currentPlayers: number | null;
  reviewTotal: number | null;
  reviewPositive: number | null;
  reviewNegative: number | null;
}

export interface RadarSearchEvidence {
  queries: string[];
  matchedIntents: string[];
  score: number;
}

export interface RadarSerpEvidence {
  query: string;
  provider: string;
  results: SteamRadarSerpResult[];
  competitorCount: number;
  score: number | null;
}

export interface RadarCollectionItem {
  game: SteamRadarItem;
  live: RadarLiveEvidence | null;
  search: RadarSearchEvidence | null;
  serp: RadarSerpEvidence | null;
}

export interface RadarCollectionPayload {
  schemaVersion: typeof STEAM_RADAR_DATA_SCHEMA_VERSION;
  runId: string;
  scheduledAt: string;
  collectedAt: string;
  collectorVersion: string;
  source: {
    name: "Steam Search";
    url: string;
    scope: string;
  };
  providerStatus: Record<string, RadarProviderState>;
  items: RadarCollectionItem[];
}

function assertObject(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象`);
  }
}

function assertString(value: unknown, field: string, maxLength = 500): asserts value is string {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new Error(`${field} 必须是 1-${maxLength} 字符的字符串`);
  }
}

function assertNullableNumber(value: unknown, field: string): asserts value is number | null {
  if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
    throw new Error(`${field} 必须是有限数字或 null`);
  }
}

function assertNullableString(value: unknown, field: string, maxLength = 500): asserts value is string | null {
  if (value !== null) assertString(value, field, maxLength);
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") throw new Error(`${field} 必须是布尔值`);
}

function assertNumber(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} 必须是 ${min}-${max} 的有限数字`);
  }
}

function assertHttpUrl(value: unknown, field: string): asserts value is string {
  assertString(value, field, 1_000);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${field} 必须是合法 URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${field} 只允许 HTTP(S)`);
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  assertString(value, field, 64);
  if (Number.isNaN(Date.parse(value))) throw new Error(`${field} 必须是合法 ISO 时间`);
}

function assertStringArray(value: unknown, field: string, maxItems = 100): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} 必须是最多 ${maxItems} 项的字符串数组`);
  }
}

function validateGame(value: unknown, index: number): asserts value is SteamRadarItem {
  const field = (name: string) => `items[${index}].game.${name}`;
  assertObject(value, `items[${index}].game`);
  assertString(value.appId, field("appId"), 32);
  if (!/^\d+$/.test(value.appId)) throw new Error(`${field("appId")} 必须是数字字符串`);
  assertString(value.title, field("title"), 300);
  assertHttpUrl(value.url, field("url"));
  if (value.capsuleUrl !== null) assertHttpUrl(value.capsuleUrl, field("capsuleUrl"));
  if (typeof value.releaseDate !== "string" || value.releaseDate.length > 100) {
    throw new Error(`${field("releaseDate")} 必须是最多 100 字符的字符串`);
  }
  if (value.releaseDateIso !== null) assertIsoDate(value.releaseDateIso, field("releaseDateIso"));
  assertNullableNumber(value.daysSinceRelease, field("daysSinceRelease"));
  assertStringArray(value.platforms, field("platforms"), 10);
  assertString(value.kind, field("kind"), 32);
  if (!["game", "demo", "dlc", "soundtrack", "unknown"].includes(value.kind)) {
    throw new Error(`${field("kind")} 非法`);
  }
  if (typeof value.priceLabel !== "string" || value.priceLabel.length > 100) {
    throw new Error(`${field("priceLabel")} 必须是最多 100 字符的字符串`);
  }
  assertBoolean(value.isFree, field("isFree"));
  assertNumber(value.discountPercent, field("discountPercent"), 0, 100);
  assertNullableString(value.reviewLabel, field("reviewLabel"), 200);
  assertNullableNumber(value.currentPlayers, field("currentPlayers"));
  assertNullableNumber(value.playerDelta3h, field("playerDelta3h"));
  assertNullableNumber(value.reviewTotal, field("reviewTotal"));
  assertNullableNumber(value.reviewDelta6h, field("reviewDelta6h"));
  for (const name of ["currentPlayers", "reviewTotal"] as const) {
    if (typeof value[name] === "number" && value[name] < 0) throw new Error(`${field(name)} 不能为负数`);
  }
  for (const name of ["evidenceCoverage", "score", "confidenceScore"] as const) {
    assertNumber(value[name], field(name), 0, 100);
  }
  for (const name of ["siteScore", "momentumScore", "searchDemandScore", "serpOpportunityScore"] as const) {
    assertNullableNumber(value[name], field(name));
    if (typeof value[name] === "number" && (value[name] < 0 || value[name] > 100)) {
      throw new Error(`${field(name)} 必须是 0-100 或 null`);
    }
  }
  assertNullableNumber(value.competitorCount, field("competitorCount"));
  if (typeof value.competitorCount === "number" && value.competitorCount < 0) {
    throw new Error(`${field("competitorCount")} 不能为负数`);
  }
  if (!["build", "validate", "watch", "skip"].includes(String(value.action))) {
    throw new Error(`${field("action")} 非法`);
  }
  if (!["low", "medium", "high"].includes(String(value.confidence))) {
    throw new Error(`${field("confidence")} 非法`);
  }
  assertStringArray(value.signals, field("signals"), 50);
  assertStringArray(value.reasonCodes, field("reasonCodes"), 50);
  assertStringArray(value.missingEvidence, field("missingEvidence"), 50);
  assertStringArray(value.keywordIdeas, field("keywordIdeas"), 50);
  assertStringArray(value.searchQueries, field("searchQueries"), 50);
  assertStringArray(value.matchedIntents, field("matchedIntents"), 50);
  assertNullableString(value.serpProvider, field("serpProvider"), 100);
  if (!Array.isArray(value.serpResults) || value.serpResults.length > 10) {
    throw new Error(`${field("serpResults")} 必须是最多 10 项的数组`);
  }
  if (!Array.isArray(value.trend14d) || value.trend14d.length > 500) {
    throw new Error(`${field("trend14d")} 必须是最多 500 项的数组`);
  }
  value.trend14d.forEach((point, pointIndex) => {
    assertObject(point, `${field("trend14d")}[${pointIndex}]`);
    assertIsoDate(point.at, `${field("trend14d")}[${pointIndex}].at`);
    assertNullableNumber(point.players, `${field("trend14d")}[${pointIndex}].players`);
    assertNullableNumber(point.reviews, `${field("trend14d")}[${pointIndex}].reviews`);
    assertNumber(point.score, `${field("trend14d")}[${pointIndex}].score`, 0, 100);
  });
  assertString(value.nextStep, field("nextStep"), 500);
  assertBoolean(value.watched, field("watched"));
  if (!Array.isArray(value.tagIds) || value.tagIds.some((item) => !Number.isInteger(item))) {
    throw new Error(`${field("tagIds")} 必须是整数数组`);
  }
}

function validateLive(value: unknown, index: number): asserts value is RadarLiveEvidence | null {
  if (value === null) return;
  assertObject(value, `items[${index}].live`);
  assertNullableNumber(value.currentPlayers, `items[${index}].live.currentPlayers`);
  assertNullableNumber(value.reviewTotal, `items[${index}].live.reviewTotal`);
  assertNullableNumber(value.reviewPositive, `items[${index}].live.reviewPositive`);
  assertNullableNumber(value.reviewNegative, `items[${index}].live.reviewNegative`);
  for (const [field, number] of Object.entries(value)) {
    if (typeof number === "number" && number < 0) throw new Error(`items[${index}].live.${field} 不能为负数`);
  }
}

function validateSearch(value: unknown, index: number): asserts value is RadarSearchEvidence | null {
  if (value === null) return;
  assertObject(value, `items[${index}].search`);
  assertStringArray(value.queries, `items[${index}].search.queries`, 40);
  assertStringArray(value.matchedIntents, `items[${index}].search.matchedIntents`, 30);
  assertNumber(value.score, `items[${index}].search.score`, 0, 100);
}

function validateSerp(value: unknown, index: number): asserts value is RadarSerpEvidence | null {
  if (value === null) return;
  assertObject(value, `items[${index}].serp`);
  assertString(value.query, `items[${index}].serp.query`, 500);
  assertString(value.provider, `items[${index}].serp.provider`, 100);
  assertNumber(value.competitorCount, `items[${index}].serp.competitorCount`, 0, 10);
  assertNullableNumber(value.score, `items[${index}].serp.score`);
  if (!Array.isArray(value.results) || value.results.length > 10) {
    throw new Error(`items[${index}].serp.results 必须是最多 10 项的数组`);
  }
  value.results.forEach((result, resultIndex) => {
    assertObject(result, `items[${index}].serp.results[${resultIndex}]`);
    assertNumber(result.position, `items[${index}].serp.results[${resultIndex}].position`, 1, 10);
    assertString(result.title, `items[${index}].serp.results[${resultIndex}].title`, 500);
    assertHttpUrl(result.url, `items[${index}].serp.results[${resultIndex}].url`);
    assertString(result.domain, `items[${index}].serp.results[${resultIndex}].domain`, 255);
    if (!["steam", "social", "big-media", "wiki", "specialist", "other"].includes(String(result.category))) {
      throw new Error(`items[${index}].serp.results[${resultIndex}].category 非法`);
    }
  });
}

export function validateRadarCollectionPayload(value: unknown): RadarCollectionPayload {
  assertObject(value, "payload");
  if (value.schemaVersion !== STEAM_RADAR_DATA_SCHEMA_VERSION) {
    throw new Error(`不支持的 schemaVersion: ${String(value.schemaVersion)}`);
  }
  assertString(value.runId, "runId", 100);
  if (!/^steam-radar:\d{4}-\d{2}-\d{2}T\d{2}$/.test(value.runId)) {
    throw new Error("runId 必须使用 steam-radar:YYYY-MM-DDTHH 时间桶");
  }
  assertIsoDate(value.scheduledAt, "scheduledAt");
  assertIsoDate(value.collectedAt, "collectedAt");
  assertString(value.collectorVersion, "collectorVersion", 100);
  assertObject(value.source, "source");
  if (value.source.name !== "Steam Search") throw new Error("source.name 必须是 Steam Search");
  assertHttpUrl(value.source.url, "source.url");
  assertString(value.source.scope, "source.scope", 300);
  assertObject(value.providerStatus, "providerStatus");
  for (const [provider, state] of Object.entries(value.providerStatus)) {
    if (!provider || !["FRESH", "PARTIAL", "MISSING", "CACHED", "ERROR"].includes(String(state))) {
      throw new Error(`providerStatus.${provider} 状态非法`);
    }
  }
  if (!Array.isArray(value.items) || value.items.length > STEAM_RADAR_MAX_ITEMS) {
    throw new Error(`items 必须是最多 ${STEAM_RADAR_MAX_ITEMS} 项的数组`);
  }
  const appIds = new Set<string>();
  value.items.forEach((item, index) => {
    assertObject(item, `items[${index}]`);
    validateGame(item.game, index);
    validateLive(item.live, index);
    validateSearch(item.search, index);
    validateSerp(item.serp, index);
    if (appIds.has(item.game.appId)) throw new Error(`items 包含重复 appId: ${item.game.appId}`);
    appIds.add(item.game.appId);
  });
  return value as unknown as RadarCollectionPayload;
}
