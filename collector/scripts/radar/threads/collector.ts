/**
 * Threads 雷达采集器
 * 基于 Googlebot UA 抓取 Threads 搜索 SSR HTML，提取结构化帖子与互动数据
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  THREADS_RADAR_DATA_SCHEMA_VERSION,
  validateThreadsRadarCollectionPayload,
  type ThreadsRadarCollectionItem,
  type ThreadsRadarCollectionPayload,
  type ThreadsRadarCollectionPost,
  type ThreadsRadarRelevance,
} from "../../../server/threads-radar-contract.ts";
import {
  alternativesOf,
  buildGroupMap,
  calculateVelocity,
  calculateViralScore,
  canonicalOf,
  getCategoryForPost,
  judgeRelevance,
} from "../../../server/threads-radar-scorer.ts";

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

export const DEFAULT_OUTPUT_PATH = "data/threads-radar/latest.json";
export const MIN_HEALTHY_BYTES = 400_000;
export const MIN_HEALTHY_POSTS = 5;
export const MAX_DEPTH = 45;
export const MAX_REQUEST_PRESSURE = 40;

export const CHANNEL_HINTS: Record<string, string> = {
  proxy_tunnel_502:
    "代理隧道 502：本机到 Threads 的出口被拒。连续高频抓取后常见，出口 IP 被 Meta 风控。停一段时间再试，或换出口。",
  rate_limited: "HTTP 429：明确被限流。降低抓取频率（减少 serp_type 变体、拉长间隔）。",
  connect_timeout: "连接超时：直连被阻断。需要走可用代理。",
  tls_reset: "TLS 被重置：链路被中间设备打断。",
  gateway: "网关错误（5xx）：上游或代理侧故障，通常可自愈。",
  empty_shell: "拿到了页面但没有 SSR 数据：UA 被降级成普通浏览器，需要 Googlebot UA。",
  unknown: "未知原因，见错误详情。",
};

export interface KeywordItem {
  group: string;
  keyword: string;
}

export interface CollectThreadsRadarOptions {
  keywords?: string[] | KeywordItem[];
  keywordsFile?: string;
  blocklist?: string[];
  blocklistFile?: string;
  variants?: string[];
  scheduledAt?: Date;
  collectorVersion?: string;
  dispatchId?: string;
  retries?: number;
  timeoutMs?: number;
  jitterMinMs?: number;
  jitterMaxMs?: number;
  skipJitter?: boolean;
  userAgent?: string;
  proxy?: string;
  dispatcher?: unknown;
}

const DISPATCH_ID_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function assertDispatchId(value: string): asserts value is string {
  if (!DISPATCH_ID_UUID_RE.test(value)) {
    throw new Error(`--dispatch-id 必须是严格 UUID，收到: ${value}`);
  }
}

export function buildRunId(dispatchId?: string, scheduledAt?: Date): string {
  if (dispatchId) {
    assertDispatchId(dispatchId);
    return `threads-radar:manual:${dispatchId}`;
  }
  return `threads-radar:${(scheduledAt ?? new Date()).toISOString()}`;
}

export function classifyError(
  error: unknown,
  status?: number,
): { reason: string; hint: string } {
  if (status === 429) {
    return { reason: "rate_limited", hint: CHANNEL_HINTS.rate_limited };
  }
  if (status && [500, 502, 503, 504].includes(status)) {
    return { reason: "gateway", hint: CHANNEL_HINTS.gateway };
  }
  const msg = error instanceof Error ? error.message : String(error);
  if (msg.includes("Tunnel connection failed") || msg.toLowerCase().includes("proxy")) {
    return { reason: "proxy_tunnel_502", hint: CHANNEL_HINTS.proxy_tunnel_502 };
  }
  if (
    msg.includes("ETIMEDOUT") ||
    msg.includes("timed out") ||
    msg.includes("TimeoutError") ||
    msg.includes("AbortError")
  ) {
    return { reason: "connect_timeout", hint: CHANNEL_HINTS.connect_timeout };
  }
  if (
    msg.includes("EOF") ||
    msg.includes("SSL") ||
    msg.includes("TLS") ||
    msg.includes("ECONNRESET") ||
    msg.includes("CERT")
  ) {
    return { reason: "tls_reset", hint: CHANNEL_HINTS.tls_reset };
  }
  return { reason: "unknown", hint: CHANNEL_HINTS.unknown };
}

export function getProxyDispatcher(proxyUrl?: string): unknown {
  return undefined;
}

export function buildThreadsSearchUrl(keyword: string, variant?: string | null): string {
  const base = `https://www.threads.com/search?q=${encodeURIComponent(keyword)}`;
  if (variant && variant !== "base") {
    return `${base}&serp_type=${encodeURIComponent(variant)}`;
  }
  return base;
}

export function chooseThumbnail(imageVersions2: unknown, maxWidth = 640): string | null {
  if (!imageVersions2 || typeof imageVersions2 !== "object") return null;
  const cands = (imageVersions2 as Record<string, unknown>).candidates;
  if (!Array.isArray(cands) || cands.length === 0) return null;

  const usable = cands.filter(
    (c): c is { url: string; width?: number | string } =>
      Boolean(
        c &&
          typeof c === "object" &&
          typeof (c as Record<string, unknown>).url === "string" &&
          (c as Record<string, unknown>).url,
      ),
  );
  if (usable.length === 0) return null;

  const getWidth = (c: { width?: number | string }): number => {
    if (typeof c.width === "number") return c.width;
    if (typeof c.width === "string") {
      const parsed = parseInt(c.width, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  };

  const fits = usable.filter((c) => getWidth(c) <= maxWidth);
  if (fits.length > 0) {
    fits.sort((a, b) => getWidth(b) - getWidth(a));
    return fits[0].url;
  }
  usable.sort((a, b) => getWidth(a) - getWidth(b));
  return usable[0].url;
}

export { chooseThumbnail as chooseThreadsThumbnail };

export function normalizePost(raw: Record<string, unknown>): ThreadsRadarCollectionPost {
  const info = (raw.text_post_app_info as Record<string, unknown> | undefined) || {};
  const caption = (raw.caption as Record<string, unknown> | undefined) || {};
  const user = (raw.user as Record<string, unknown> | undefined) || {};

  const usernameRaw = typeof user.username === "string" ? user.username.trim() : "";
  const username = usernameRaw || "anonymous";

  const code = typeof raw.code === "string" ? raw.code.trim() : "";
  const url = `https://www.threads.com/@${username}/post/${code}`;

  const userId =
    user.pk != null
      ? String(user.pk)
      : user.id != null
        ? String(user.id)
        : raw.user_id != null
          ? String(raw.user_id)
          : raw.userId != null
            ? String(raw.userId)
            : null;

  const verified = Boolean(user.is_verified ?? raw.verified);
  const text =
    typeof caption.text === "string"
      ? caption.text
      : typeof raw.text === "string"
        ? raw.text
        : "";

  const lang =
    typeof raw.detected_language === "string"
      ? raw.detected_language
      : typeof raw.lang === "string"
        ? raw.lang
        : null;

  const likeCount = Math.max(
    0,
    parseInt(String(raw.like_count ?? raw.likeCount ?? 0), 10) || 0,
  );
  const replyCount = Math.max(
    0,
    parseInt(
      String(info.direct_reply_count ?? raw.reply_count ?? raw.replyCount ?? 0),
      10,
    ) || 0,
  );
  const repostCount = Math.max(
    0,
    parseInt(
      String(info.repost_count ?? raw.repost_count ?? raw.repostCount ?? 0),
      10,
    ) || 0,
  );
  const quoteCount = Math.max(
    0,
    parseInt(
      String(info.quote_count ?? raw.quote_count ?? raw.quoteCount ?? 0),
      10,
    ) || 0,
  );

  const takenAt =
    parseInt(String(raw.taken_at ?? raw.takenAt ?? 0), 10) || 0;

  const mediaType =
    typeof raw.media_type === "number"
      ? raw.media_type
      : typeof raw.mediaType === "number"
        ? raw.mediaType
        : null;

  const imageVersions2 = raw.image_versions2 ?? raw.imageVersions2;
  const candidates =
    imageVersions2 && typeof imageVersions2 === "object"
      ? (imageVersions2 as Record<string, unknown>).candidates
      : undefined;
  const hasImage = Array.isArray(candidates) && candidates.length > 0;
  const thumb = hasImage ? chooseThumbnail(imageVersions2, 640) : null;

  const isReply = Boolean(info.is_reply ?? raw.isReply ?? raw.is_reply);

  const tagHeader = info.tag_header ?? raw.tag_header;
  const tag =
    tagHeader &&
    typeof tagHeader === "object" &&
    typeof (tagHeader as Record<string, unknown>).display_name === "string"
      ? ((tagHeader as Record<string, unknown>).display_name as string)
      : typeof raw.tag === "string"
        ? raw.tag
        : null;

  const keywords = Array.isArray(raw.keywords) ? (raw.keywords as string[]) : [];
  const category = typeof raw.category === "string" ? raw.category : "未分组";
  const relevance = (raw.relevance as ThreadsRadarRelevance) || "relevant";
  const relevanceNote =
    (raw.relevanceNote as string) || (raw.relevance_note as string) || "";
  const score = typeof raw.score === "number" ? raw.score : 0;
  const velocity = typeof raw.velocity === "number" ? raw.velocity : 0;

  return {
    code,
    url,
    username,
    userId,
    verified,
    text,
    lang,
    likeCount,
    replyCount,
    repostCount,
    quoteCount,
    takenAt,
    mediaType,
    hasImage,
    thumb,
    isReply,
    tag,
    keywords,
    category,
    relevance,
    relevanceNote,
    score,
    velocity,
  };
}

export { normalizePost as normalizeThreadsPost };

function walk(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > MAX_DEPTH || !node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, out, depth + 1);
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if ("code" in obj && "like_count" in obj && "text_post_app_info" in obj) {
    out.push(obj);
    return;
  }
  for (const value of Object.values(obj)) {
    walk(value, out, depth + 1);
  }
}

export function parseThreadsSearchHtml(html: string): ThreadsRadarCollectionPost[] {
  const posts: ThreadsRadarCollectionPost[] = [];
  const seenCodes = new Set<string>();

  const scriptRegex =
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const blob = match[1];
    if (!blob.includes("like_count")) {
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(blob);
    } catch {
      continue;
    }
    const found: Record<string, unknown>[] = [];
    walk(payload, found, 0);

    for (const raw of found) {
      const code = typeof raw.code === "string" ? raw.code.trim() : "";
      if (!code || seenCodes.has(code)) {
        continue;
      }
      seenCodes.add(code);
      posts.push(normalizePost(raw));
    }
  }

  return posts;
}

export function parseKeywordsText(content: string): KeywordItem[] {
  const result: KeywordItem[] = [];
  let currentGroup = "";
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^\[(.*?)\]\s*(.*)$/);
    if (match) {
      currentGroup = match[1].trim();
      const rest = match[2].trim();
      if (rest) {
        result.push({ group: currentGroup, keyword: rest });
      }
      continue;
    }
    result.push({ group: currentGroup, keyword: line });
  }
  return result;
}

export function parseBlocklistText(content: string): string[] {
  const result: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    result.push(line);
  }
  return result;
}

export function parseArgs(argv = process.argv.slice(2)): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`未知参数: ${key}`);
    const stripped = key.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result.set(stripped, "true");
    } else {
      result.set(stripped, next);
      index += 1;
    }
  }
  return result;
}

export async function collectThreadsRadarData(
  fetcherOrOptions?: typeof fetch | CollectThreadsRadarOptions,
  options?: CollectThreadsRadarOptions,
): Promise<ThreadsRadarCollectionPayload> {
  let fetcher: typeof fetch;
  let opts: CollectThreadsRadarOptions;

  if (typeof fetcherOrOptions === "function") {
    fetcher = fetcherOrOptions;
    opts = options ?? {};
  } else if (fetcherOrOptions && typeof fetcherOrOptions === "object") {
    opts = fetcherOrOptions;
    fetcher = fetch;
  } else {
    fetcher = fetch;
    opts = options ?? {};
  }

  // 1. Resolve keywords
  let keywordItems: KeywordItem[] = [];
  if (opts.keywords) {
    if (Array.isArray(opts.keywords)) {
      let currentGroup = "";
      for (const item of opts.keywords) {
        if (typeof item === "string") {
          const trimmed = item.trim();
          const match = trimmed.match(/^\[(.*?)\]\s*(.*)$/);
          if (match) {
            currentGroup = match[1].trim();
            const rest = match[2].trim();
            if (rest) {
              keywordItems.push({ group: currentGroup, keyword: rest });
            }
          } else if (trimmed) {
            keywordItems.push({ group: currentGroup, keyword: trimmed });
          }
        } else if (item && typeof item === "object") {
          keywordItems.push(item);
        }
      }
    }
  } else if (opts.keywordsFile) {
    const content = await readFile(opts.keywordsFile, "utf8");
    keywordItems = parseKeywordsText(content);
  } else {
    const fileFromEnv =
      process.env.THREADS_RADAR_KEYWORDS_FILE ||
      process.env.RADAR_KEYWORDS_FILE ||
      process.env.RADAR_KEYWORDS_PATH;
    if (fileFromEnv) {
      const content = await readFile(fileFromEnv, "utf8");
      keywordItems = parseKeywordsText(content);
    } else {
      const rawEnv =
        process.env.THREADS_RADAR_KEYWORDS || process.env.RADAR_KEYWORDS;
      if (rawEnv) {
        keywordItems = parseKeywordsText(rawEnv);
      }
    }
  }

  if (keywordItems.length === 0) {
    throw new Error(
      "缺少关键词配置：请通过 keywords, keywordsFile 或环境变量提供",
    );
  }

  // 2. Resolve blocklist
  let blocklist: string[] = [];
  if (opts.blocklist) {
    blocklist = opts.blocklist.map((s) => s.trim()).filter(Boolean);
  } else if (opts.blocklistFile) {
    const content = await readFile(opts.blocklistFile, "utf8");
    blocklist = parseBlocklistText(content);
  } else {
    const blockFileFromEnv =
      process.env.THREADS_RADAR_BLOCKLIST_FILE ||
      process.env.RADAR_BLOCKLIST_FILE ||
      process.env.RADAR_BLOCKLIST_PATH;
    if (blockFileFromEnv) {
      const content = await readFile(blockFileFromEnv, "utf8");
      blocklist = parseBlocklistText(content);
    } else {
      const blockEnv =
        process.env.THREADS_RADAR_BLOCKLIST || process.env.RADAR_BLOCKLIST;
      if (blockEnv) {
        blocklist = parseBlocklistText(blockEnv);
      }
    }
  }

  // 3. Resolve variants & pressure limit
  const variants =
    opts.variants && opts.variants.length > 0
      ? opts.variants
      : (
          process.env.RADAR_SERP_TYPES || process.env.THREADS_RADAR_SERP_TYPES
        )
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean) ?? ["base", "profile"];

  const keywordCount = keywordItems.length;
  const variantCount = variants.length;
  const totalPressure = keywordCount * variantCount;
  if (totalPressure > MAX_REQUEST_PRESSURE) {
    throw new Error(
      `Request pressure limit exceeded: ${keywordCount} keywords * ${variantCount} variants = ${totalPressure} (maximum allowed: ${MAX_REQUEST_PRESSURE})`,
    );
  }

  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const scheduledAt = opts.scheduledAt ?? new Date();
  const collectorVersion =
    opts.collectorVersion ?? process.env.GITHUB_SHA ?? "local";

  const jitterMinMs = opts.skipJitter ? 0 : (opts.jitterMinMs ?? 1800);
  const jitterMaxMs = opts.skipJitter ? 0 : (opts.jitterMaxMs ?? 4200);

  const dispatcher = opts.dispatcher ?? getProxyDispatcher(opts.proxy);

  const mergedPosts = new Map<string, ThreadsRadarCollectionPost>();
  let totalBytes = 0;
  let totalRequests = 0;
  let failedRequests = 0;
  const reasonCounts: Record<string, number> = {};

  for (let kwIdx = 0; kwIdx < keywordItems.length; kwIdx += 1) {
    const item = keywordItems[kwIdx];
    const canonicalQuery = canonicalOf(item.keyword);

    for (let varIdx = 0; varIdx < variants.length; varIdx += 1) {
      const variant = variants[varIdx];
      const url = buildThreadsSearchUrl(canonicalQuery, variant);
      totalRequests += 1;

      let lastError: unknown;
      let lastStatus: number | undefined;
      let html: string | null = null;

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const fetchInit: RequestInit & { dispatcher?: unknown } = {
            method: "GET",
            headers: {
              "User-Agent": userAgent,
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "en-US,en;q=0.9",
              "Cache-Control": "no-cache",
            },
            signal: AbortSignal.timeout(timeoutMs),
          };
          if (dispatcher) {
            fetchInit.dispatcher = dispatcher;
          }

          const response = await fetcher(url, fetchInit);
          lastStatus = response.status;

          if (response.ok) {
            html = await response.text();
            break;
          }

          if (
            response.status === 429 ||
            (response.status >= 500 && response.status <= 504)
          ) {
            lastError = new Error(`HTTP ${response.status}`);
          } else {
            // Non-retryable 4xx
            lastError = new Error(`HTTP ${response.status}`);
            break;
          }
        } catch (err) {
          lastError = err;
          const { reason } = classifyError(err, lastStatus);
          if (
            (reason === "proxy_tunnel_502" || reason === "tls_reset") &&
            attempt >= 1
          ) {
            break;
          }
        }

        if (attempt < retries && !opts.skipJitter) {
          const backoff = Math.pow(2, attempt) * 1000 + (Math.random() * 1000 + 500);
          await delay(backoff);
        }
      }

      if (html !== null) {
        totalBytes += html.length;
        const parsed = parseThreadsSearchHtml(html);

        if (html.length < MIN_HEALTHY_BYTES && parsed.length === 0) {
          reasonCounts["empty_shell"] = (reasonCounts["empty_shell"] || 0) + 1;
        }

        for (const post of parsed) {
          const existing = mergedPosts.get(post.code);
          if (existing) {
            const mergedKws = Array.from(
              new Set([...(existing.keywords || []), item.keyword]),
            );
            existing.keywords = mergedKws;
          } else {
            post.keywords = [item.keyword];
            mergedPosts.set(post.code, post);
          }
        }
      } else {
        failedRequests += 1;
        const { reason } = classifyError(lastError, lastStatus);
        reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
      }

      // Jitter delay between requests
      const isLastRequest =
        kwIdx === keywordItems.length - 1 && varIdx === variants.length - 1;
      if (!isLastRequest && jitterMaxMs > 0) {
        const jitterTime =
          jitterMinMs + Math.random() * Math.max(0, jitterMaxMs - jitterMinMs);
        await delay(jitterTime);
      }
    }
  }

  // 4. Drop all-four-zero interaction posts
  const nonZeroPosts = Array.from(mergedPosts.values()).filter((p) => {
    return p.likeCount + p.replyCount + p.repostCount + p.quoteCount > 0;
  });

  // 5. Shared scorer enrichment: relevance, category, score, velocity
  const groupMap = buildGroupMap(keywordItems.map((k) => [k.group, k.keyword]));
  for (const k of keywordItems) {
    const canonical = canonicalOf(k.keyword);
    if (!groupMap[canonical]) {
      groupMap[canonical] = k.group;
    }
  }

  const now = scheduledAt;
  const enrichedItems: ThreadsRadarCollectionItem[] = nonZeroPosts.map((post) => {
    const judge = judgeRelevance(post, post.keywords || [], blocklist);
    const category = getCategoryForPost(post, groupMap);
    const score = calculateViralScore(post, now);
    const velocity = calculateVelocity(post, now);

    return {
      post: {
        ...post,
        category,
        relevance: judge.relevance,
        relevanceNote: judge.note,
        score,
        velocity,
      },
    };
  });

  // 6. Build channel health
  let topReason = "ok";
  if (failedRequests > 0 || (totalBytes < MIN_HEALTHY_BYTES && enrichedItems.length === 0)) {
    let maxCount = 0;
    for (const [r, count] of Object.entries(reasonCounts)) {
      if (count > maxCount) {
        maxCount = count;
        topReason = r;
      }
    }
  }
  const topHint = CHANNEL_HINTS[topReason] ?? CHANNEL_HINTS.unknown;

  const isHealthy =
    totalRequests > 0 &&
    failedRequests < totalRequests &&
    enrichedItems.length > 0;

  const channelHealth: Record<string, string | number | boolean> = {
    healthy: isHealthy,
    totalRequests,
    failedRequests,
    totalBytes,
    totalPosts: enrichedItems.length,
    reason: topReason,
    hint: topHint,
  };

  const collectedAt = new Date();
  const runId = buildRunId(opts.dispatchId, scheduledAt);

  const payload: ThreadsRadarCollectionPayload = {
    schemaVersion: THREADS_RADAR_DATA_SCHEMA_VERSION,
    runId,
    scheduledAt: scheduledAt.toISOString(),
    collectedAt: collectedAt.toISOString(),
    collectorVersion,
    source: {
      name: "Threads Public Search",
      url: "https://www.threads.com",
      scope: "threads-search-radar",
    },
    channelHealth,
    items: enrichedItems,
  };

  return validateThreadsRadarCollectionPayload(payload);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const output = path.resolve(
    args.get("output") ?? DEFAULT_OUTPUT_PATH,
  );

  const keywordsArg = args.get("keywords");
  const keywordsFile =
    args.get("keywords-file") ??
    process.env.THREADS_RADAR_KEYWORDS_FILE ??
    process.env.RADAR_KEYWORDS_FILE ??
    process.env.RADAR_KEYWORDS_PATH;
  const keywordsEnv =
    process.env.THREADS_RADAR_KEYWORDS ?? process.env.RADAR_KEYWORDS;

  if (!keywordsArg && !keywordsFile && !keywordsEnv) {
    throw new Error(
      "缺少关键词配置：请通过 --keywords, --keywords-file 或环境变量 THREADS_RADAR_KEYWORDS / THREADS_RADAR_KEYWORDS_FILE 提供",
    );
  }

  const blocklistArg = args.get("blocklist");
  const blocklistFile =
    args.get("blocklist-file") ??
    process.env.THREADS_RADAR_BLOCKLIST_FILE ??
    process.env.RADAR_BLOCKLIST_FILE ??
    process.env.RADAR_BLOCKLIST_PATH;
  const blocklistEnv =
    process.env.THREADS_RADAR_BLOCKLIST ?? process.env.RADAR_BLOCKLIST;

  if (!blocklistArg && !blocklistFile && !blocklistEnv) {
    throw new Error(
      "缺少屏蔽词配置：请通过 --blocklist, --blocklist-file 或环境变量 THREADS_RADAR_BLOCKLIST / THREADS_RADAR_BLOCKLIST_FILE 提供",
    );
  }

  let keywords: KeywordItem[] = [];
  if (keywordsFile) {
    const content = await readFile(keywordsFile, "utf8");
    keywords = parseKeywordsText(content);
  } else if (keywordsArg) {
    keywords = parseKeywordsText(keywordsArg);
  } else if (keywordsEnv) {
    keywords = parseKeywordsText(keywordsEnv);
  }

  let blocklist: string[] = [];
  if (blocklistFile) {
    const content = await readFile(blocklistFile, "utf8");
    blocklist = parseBlocklistText(content);
  } else if (blocklistArg) {
    blocklist = parseBlocklistText(blocklistArg);
  } else if (blocklistEnv) {
    blocklist = parseBlocklistText(blocklistEnv);
  }

  const variantsRaw =
    args.get("serp-types") ??
    args.get("variants") ??
    process.env.RADAR_SERP_TYPES ??
    process.env.THREADS_RADAR_SERP_TYPES;
  const variants = variantsRaw
    ? variantsRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : ["base", "profile"];

  const scheduledAtRaw =
    args.get("scheduled-at") ?? process.env.RADAR_SCHEDULED_AT;
  const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : new Date();
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new Error("--scheduled-at 必须是合法时间");
  }

  const collectorVersion =
    args.get("collector-version") ?? process.env.GITHUB_SHA ?? "local";

  const dispatchIdRaw = args.get("dispatch-id");
  if (dispatchIdRaw !== undefined) {
    assertDispatchId(dispatchIdRaw);
  }

  const payload = await collectThreadsRadarData({
    keywords,
    blocklist,
    variants,
    scheduledAt,
    collectorVersion,
    dispatchId: dispatchIdRaw,
    skipJitter: args.get("skip-jitter") === "true",
  });

  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  process.stdout.write(
    `${JSON.stringify({
      output,
      runId: payload.runId,
      itemCount: payload.items.length,
      channelHealth: payload.channelHealth,
    })}\n`,
  );

  if (payload.items.length === 0 && !payload.channelHealth?.healthy) {
    process.stderr.write(
      `通道总故障 (total channel failure): ${payload.channelHealth?.reason ?? "0 产出且通道异常"}\n`,
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
