/**
 * Threads 雷达采集契约校验
 * 契约规范：
 * - schemaVersion: threads-radar-data-v1
 * - runId: threads-radar:<ISO-8601 timestamp>，允许同一小时内安全重跑
 * - 指标: 有限非负数字 (finite nonnegative)
 * - URL: 仅允许 HTTP(S)
 * - post code: 唯一无重复
 * - items: 数组有上限
 */

export type ThreadsRadarRelevance = "relevant" | "blocked" | "offtopic";

export interface ThreadsRadarCollectionPost {
  code: string;
  url: string;
  username: string;
  userId?: string | null;
  verified?: boolean;
  text?: string;
  lang?: string | null;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  quoteCount: number;
  takenAt: number;
  mediaType?: number | null;
  hasImage?: boolean;
  thumb?: string | null;
  isReply?: boolean;
  tag?: string | null;
  keywords?: string[];
  category?: string;
  relevance?: ThreadsRadarRelevance;
  relevanceNote?: string;
  score?: number;
  velocity?: number;
}

export interface ThreadsRadarCollectionItem {
  post: ThreadsRadarCollectionPost;
}

export interface ThreadsRadarCollectionPayload {
  schemaVersion: "threads-radar-data-v1";
  runId: string;
  scheduledAt: string;
  collectedAt: string;
  collectorVersion: string;
  source: {
    name: string;
    url: string;
    scope: string;
  };
  channelHealth?: Record<string, string | number | boolean>;
  items: ThreadsRadarCollectionItem[];
}
export const THREADS_RADAR_DATA_SCHEMA_VERSION = "threads-radar-data-v1" as const;
export const THREADS_RADAR_MAX_ITEMS = 1000;
export const THREADS_RADAR_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;

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

function assertOptionalString(
  value: unknown,
  field: string,
  maxLength = 500,
): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== "string" || value.length > maxLength)) {
    throw new Error(`${field} 必须是最多 ${maxLength} 字符的字符串`);
  }
}

function assertNullableString(
  value: unknown,
  field: string,
  maxLength = 500,
): asserts value is string | null {
  if (value !== null && value !== undefined) {
    assertString(value, field, maxLength);
  }
}

function assertBoolean(value: unknown, field: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} 必须是布尔值`);
  }
}

function assertNonnegativeFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} 必须是有限非负数字`);
  }
}

function assertNullableNumber(value: unknown, field: string): asserts value is number | null {
  if (value !== null && value !== undefined) {
    assertNonnegativeFiniteNumber(value, field);
  }
}

function assertHttpUrl(value: unknown, field: string): asserts value is string {
  assertString(value, field, 2000);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} 必须是合法 URL`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${field} 只允许 HTTP(S)`);
  }
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  assertString(value, field, 64);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} 必须是合法 ISO 时间`);
  }
}

function assertStringArray(value: unknown, field: string, maxItems = 100): asserts value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} 必须是最多 ${maxItems} 项的字符串数组`);
  }
}

export function validateThreadsRadarPost(raw: unknown, index: number): ThreadsRadarCollectionPost {
  const prefix = `items[${index}]`;
  assertObject(raw, prefix);

  const codeVal = raw.code;
  assertString(codeVal, `${prefix}.code`, 100);

  const urlVal = raw.url;
  assertHttpUrl(urlVal, `${prefix}.url`);

  const usernameVal = raw.username;
  assertString(usernameVal, `${prefix}.username`, 100);

  const userIdVal = raw.userId ?? raw.user_id;
  assertNullableString(userIdVal, `${prefix}.userId`, 100);

  if (raw.verified !== undefined) {
    assertBoolean(raw.verified, `${prefix}.verified`);
  }

  assertOptionalString(raw.text as string | undefined, `${prefix}.text`, 50000);

  const langVal = raw.lang;
  assertNullableString(langVal, `${prefix}.lang`, 32);

  // Exact Threads-only metrics - required metrics must be present and finite nonnegative
  const rawLike = raw.likeCount ?? raw.like_count;
  if (rawLike === undefined || rawLike === null) {
    throw new Error(`${prefix}.likeCount 必须提供`);
  }
  assertNonnegativeFiniteNumber(rawLike, `${prefix}.likeCount`);
  const likeVal = rawLike;

  const rawReply = raw.replyCount ?? raw.reply_count;
  if (rawReply === undefined || rawReply === null) {
    throw new Error(`${prefix}.replyCount 必须提供`);
  }
  assertNonnegativeFiniteNumber(rawReply, `${prefix}.replyCount`);
  const replyVal = rawReply;

  const rawRepost = raw.repostCount ?? raw.repost_count;
  if (rawRepost === undefined || rawRepost === null) {
    throw new Error(`${prefix}.repostCount 必须提供`);
  }
  assertNonnegativeFiniteNumber(rawRepost, `${prefix}.repostCount`);
  const repostVal = rawRepost;

  const rawQuote = raw.quoteCount ?? raw.quote_count;
  if (rawQuote === undefined || rawQuote === null) {
    throw new Error(`${prefix}.quoteCount 必须提供`);
  }
  assertNonnegativeFiniteNumber(rawQuote, `${prefix}.quoteCount`);
  const quoteVal = rawQuote;

  const rawTaken = raw.takenAt ?? raw.taken_at;
  if (rawTaken === undefined || rawTaken === null) {
    throw new Error(`${prefix}.takenAt 必须提供`);
  }
  assertNonnegativeFiniteNumber(rawTaken, `${prefix}.takenAt`);
  const takenVal = rawTaken;

  if (likeVal + replyVal + repostVal + quoteVal <= 0) {
    throw new Error(`${prefix} 互动总量必须大于 0`);
  }

  const mediaTypeVal = raw.mediaType ?? raw.media_type;
  assertNullableNumber(mediaTypeVal, `${prefix}.mediaType`);

  const hasImageVal = raw.hasImage ?? raw.has_image;
  if (hasImageVal !== undefined) {
    assertBoolean(hasImageVal, `${prefix}.hasImage`);
  }

  const thumbVal = raw.thumb;
  if (thumbVal !== null && thumbVal !== undefined && thumbVal !== "") {
    assertHttpUrl(thumbVal, `${prefix}.thumb`);
  }

  const isReplyVal = raw.isReply ?? raw.is_reply;
  if (isReplyVal !== undefined) {
    assertBoolean(isReplyVal, `${prefix}.isReply`);
  }

  const tagVal = raw.tag;
  assertNullableString(tagVal, `${prefix}.tag`, 200);

  let keywordsVal = raw.keywords ?? raw.keywords_json;
  if (typeof keywordsVal === "string") {
    try {
      keywordsVal = JSON.parse(keywordsVal);
    } catch {
      keywordsVal = [keywordsVal];
    }
  }
  if (keywordsVal !== undefined) {
    assertStringArray(keywordsVal, `${prefix}.keywords`, 50);
  }

  const categoryVal = raw.category;
  if (categoryVal !== undefined) {
    assertString(categoryVal, `${prefix}.category`, 100);
  }

  const relevanceVal = raw.relevance;
  if (relevanceVal !== undefined) {
    assertString(relevanceVal, `${prefix}.relevance`, 32);
    if (!["relevant", "blocked", "offtopic"].includes(relevanceVal)) {
      throw new Error(`${prefix}.relevance 非法，只支持 relevant | blocked | offtopic`);
    }
  }

  const relevanceNoteVal = raw.relevanceNote ?? raw.relevance_note;
  if (relevanceNoteVal !== undefined) {
    assertOptionalString(relevanceNoteVal as string, `${prefix}.relevanceNote`, 500);
  }

  const scoreVal = raw.score ?? 0;
  assertNonnegativeFiniteNumber(scoreVal, `${prefix}.score`);

  const velocityVal = raw.velocity ?? 0;
  assertNonnegativeFiniteNumber(velocityVal, `${prefix}.velocity`);

  return {
    code: codeVal,
    url: urlVal,
    username: usernameVal,
    userId: (userIdVal as string | null) ?? null,
    verified: Boolean(raw.verified),
    text: (raw.text as string) || "",
    lang: (langVal as string | null) ?? null,
    likeCount: likeVal,
    replyCount: replyVal,
    repostCount: repostVal,
    quoteCount: quoteVal,
    takenAt: takenVal,
    mediaType: mediaTypeVal !== undefined ? (mediaTypeVal as number | null) : null,
    hasImage: Boolean(hasImageVal),
    thumb: (thumbVal as string | null) || null,
    isReply: Boolean(isReplyVal),
    tag: (tagVal as string | null) ?? null,
    keywords: (keywordsVal as string[]) || [],
    category: (categoryVal as string) || "未分组",
    relevance: (relevanceVal as ThreadsRadarRelevance) || "relevant",
    relevanceNote: (relevanceNoteVal as string) || "",
    score: scoreVal,
    velocity: velocityVal,
  };
}

export function validateThreadsRadarCollectionPayload(value: unknown): ThreadsRadarCollectionPayload {
  assertObject(value, "payload");

  if (value.schemaVersion !== THREADS_RADAR_DATA_SCHEMA_VERSION) {
    throw new Error(`不支持的 schemaVersion: ${String(value.schemaVersion)}`);
  }

  assertString(value.runId, "runId", 100);
  if (!/^threads-radar:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.runId)) {
    throw new Error("runId 必须使用 threads-radar:<ISO-8601 timestamp> 格式");
  }

  assertIsoDate(value.scheduledAt, "scheduledAt");
  assertIsoDate(value.collectedAt, "collectedAt");
  assertString(value.collectorVersion, "collectorVersion", 100);

  assertObject(value.source, "source");
  assertString(value.source.name, "source.name", 100);
  assertHttpUrl(value.source.url, "source.url");
  assertString(value.source.scope, "source.scope", 300);

  if (value.channelHealth !== undefined) {
    assertObject(value.channelHealth, "channelHealth");
  }

  if (!Array.isArray(value.items) || value.items.length > THREADS_RADAR_MAX_ITEMS) {
    throw new Error(`items 必须是最多 ${THREADS_RADAR_MAX_ITEMS} 项的数组`);
  }

  const seenCodes = new Set<string>();
  const validatedItems: ThreadsRadarCollectionItem[] = [];

  value.items.forEach((item, index) => {
    assertObject(item, `items[${index}]`);
    if (!item.post || typeof item.post !== "object" || Array.isArray(item.post)) {
      throw new Error(`items[${index}].post 必须是对象`);
    }
    const post = validateThreadsRadarPost(item.post, index);

    if (seenCodes.has(post.code)) {
      throw new Error(`items 包含重复 post code: ${post.code}`);
    }
    seenCodes.add(post.code);

    validatedItems.push({
      post,
    });
  });

  return {
    schemaVersion: THREADS_RADAR_DATA_SCHEMA_VERSION,
    runId: value.runId,
    scheduledAt: value.scheduledAt,
    collectedAt: value.collectedAt,
    collectorVersion: value.collectorVersion,
    source: {
      name: value.source.name as string,
      url: value.source.url as string,
      scope: value.source.scope as string,
    },
    channelHealth: value.channelHealth as Record<string, string | number | boolean> | undefined,
    items: validatedItems,
  };
}

export function parseThreadsRadarImportPayload(rawBody: string): ThreadsRadarCollectionPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new Error("采集 payload 不是合法 JSON");
  }
  return validateThreadsRadarCollectionPayload(parsed);
}
