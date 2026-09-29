/**
 * Threads AI 爆款雷达算法与指标
 * 100% 对齐 Python 原型 (scorer.py, relevance.py, store.py)
 */

import type { ThreadsRadarRelevance } from "./threads-radar-contract.ts";

export type ThreadsAuthorTier = "core" | "steady" | "single_hit" | "casual";

export interface ThreadsNamedCount {
  name: string;
  count: number;
}

export interface ThreadsRadarPost {
  code: string;
  url: string;
  username: string;
  userId: string | null;
  verified: boolean;
  text: string;
  lang: string | null;
  likeCount: number;
  replyCount: number;
  repostCount: number;
  quoteCount: number;
  takenAt: number;
  mediaType: number | null;
  hasImage: boolean;
  thumb: string | null;
  isReply: boolean;
  tag: string | null;
  keywords: string[];
  category: string;
  relevance: ThreadsRadarRelevance;
  relevanceNote: string;
  score: number;
  velocity: number;
  firstSeenAt: string;
  lastSeenAt: string;
  isNew: boolean;
}

export interface ThreadsAuthorAggregate {
  username: string;
  posts: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  interactions: number;
  hits: number;
  hitRate: number;
  bestScore: number | null;
  bestLikes: number;
  firstAt: number | null;
  lastAt: number | null;
  activeDays: number;
  postsPerWeek: number | null;
  verified: boolean;
  newCount: number;
  topCategories: ThreadsNamedCount[];
  topKeywords: ThreadsNamedCount[];
  tier: ThreadsAuthorTier;
  tierLabel: string;
  isWatched?: boolean;
  note?: string;
}

export const FIT_TERMS = [
  "ai",
  "gpt",
  "chatgpt",
  "prompt",
  "workflow",
  "tool",
  "agent",
  "claude",
  "gemini",
  "midjourney",
  "image",
  "video",
] as const;

export const HIT_THRESHOLD = 500;

export const AUTHOR_TIER_CORE = "core" as const;
export const AUTHOR_TIER_STEADY = "steady" as const;
export const AUTHOR_TIER_SINGLE = "single_hit" as const;
export const AUTHOR_TIER_CASUAL = "casual" as const;

export const AUTHOR_TIER_LABELS: Record<ThreadsAuthorTier, string> = {
  core: "核心监控",
  steady: "持续产出",
  single_hit: "单帖爆款",
  casual: "偶发出现",
};

export const AUTHOR_TIER_SORT: Record<ThreadsAuthorTier, string> = {
  core: "hits",
  steady: "posts",
  single_hit: "interactions",
  casual: "interactions",
};

export interface ThreadsMetricsLike {
  likeCount?: number | null;
  like_count?: number | null;
  replyCount?: number | null;
  reply_count?: number | null;
  repostCount?: number | null;
  repost_count?: number | null;
  quoteCount?: number | null;
  quote_count?: number | null;
  takenAt?: number | null;
  taken_at?: number | null;
  text?: string | null;
  tag?: string | null;
  keywords?: string[] | null;
  category?: string | null;
}

function normalizeTimestampMs(val?: Date | number | null): number {
  if (val instanceof Date) return val.getTime();
  if (typeof val === "number" && Number.isFinite(val)) {
    // If timestamp is in seconds (< 1e11), convert to milliseconds
    return val < 1e11 ? val * 1000 : val;
  }
  return Date.now();
}

/**
 * 时间衰减因子：基于发布时间 taken_at
 * 衰减公式: 1 / sqrt(1 + hours / 24)
 * 接受可选的 now 参数以保证测试的确定性
 */
export function recencyFactor(takenAt: number, now?: Date | number): number {
  if (!takenAt || !Number.isFinite(takenAt) || takenAt <= 0) {
    return 1.0;
  }
  const takenAtMs = takenAt < 1e11 ? takenAt * 1000 : takenAt;
  const nowMs = normalizeTimestampMs(now);
  const diffMs = nowMs - takenAtMs;
  if (diffMs <= 0) {
    return 1.0;
  }
  const hours = diffMs / 3_600_000;
  return 1 / Math.sqrt(1 + hours / 24);
}

/**
 * 单帖互动总数 = 点赞 + 回复 + 转发 + 引用
 */
export function calculateInteractions(post: ThreadsMetricsLike): number {
  const likes = Math.max(0, Math.floor(Number(post.likeCount ?? post.like_count ?? 0))) || 0;
  const replies = Math.max(0, Math.floor(Number(post.replyCount ?? post.reply_count ?? 0))) || 0;
  const reposts = Math.max(0, Math.floor(Number(post.repostCount ?? post.repost_count ?? 0))) || 0;
  const quotes = Math.max(0, Math.floor(Number(post.quoteCount ?? post.quote_count ?? 0))) || 0;
  return likes + replies + reposts + quotes;
}

/**
 * 爆款综合评分 (Viral Score)
 * raw = 1.0 * ln(1 + likes) + 2.5 * ln(1 + replies) + 3.0 * ln(1 + reposts) + 3.0 * ln(1 + quotes)
 * fit = 正文含核心 AI 词乘 1.25，否则 1.0
 * score = round(raw * fit * recency, 4)
 */
export function calculateViralScore(post: ThreadsMetricsLike, now?: Date | number): number {
  const likes = Math.max(0, Math.floor(Number(post.likeCount ?? post.like_count ?? 0))) || 0;
  const replies = Math.max(0, Math.floor(Number(post.replyCount ?? post.reply_count ?? 0))) || 0;
  const reposts = Math.max(0, Math.floor(Number(post.repostCount ?? post.repost_count ?? 0))) || 0;
  const quotes = Math.max(0, Math.floor(Number(post.quoteCount ?? post.quote_count ?? 0))) || 0;

  const raw =
    1.0 * Math.log1p(likes) +
    2.5 * Math.log1p(replies) +
    3.0 * Math.log1p(reposts) +
    3.0 * Math.log1p(quotes);

  const text = (post.text || "").toLowerCase();
  const fit = FIT_TERMS.some((term) => text.includes(term)) ? 1.25 : 1.0;
  const takenAt = Number(post.takenAt ?? post.taken_at ?? 0);
  const recency = recencyFactor(takenAt, now);

  const score = raw * fit * recency;
  return Math.round((score + Number.EPSILON) * 10000) / 10000;
}

/**
 * 每小时互动增长速度 (Velocity)
 * velocity = total / max(1.0, hours)
 */
export function calculateVelocity(post: ThreadsMetricsLike, now?: Date | number): number {
  const total = calculateInteractions(post);
  if (!total) {
    return 0.0;
  }
  const taken = Number(post.takenAt ?? post.taken_at ?? 0);
  if (!taken) {
    return Number(total.toFixed(4));
  }
  const nowMs = normalizeTimestampMs(now);
  const takenMs = taken < 1e11 ? taken * 1000 : taken;
  const hours = Math.max(1.0, (nowMs - takenMs) / 3_600_000);
  return Math.round((total / hours + Number.EPSILON) * 10000) / 10000;
}

/**
 * 互动量的紧凑格式化输出
 */
export function formatCompactInteractions(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

/**
 * 构建关键词与分组的映射表
 */
export function buildGroupMap(pairs: Array<[group: string, keyword: string]>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [group, keyword] of pairs) {
    if (group && keyword) {
      map[keyword] = group;
    }
  }
  return map;
}

/**
 * 用命中的第一个关键词所属分组作为分类
 */
export function getCategoryForPost(
  post: { keywords?: string[] | null },
  groupMap: Record<string, string>,
): string {
  for (const kw of post.keywords || []) {
    if (kw && groupMap[kw]) {
      return groupMap[kw];
    }
  }
  return "未分组";
}

// ----------------------------------------------------------------- Relevance

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const patternCache = new Map<string, RegExp>();

export function getTokenPattern(token: string): RegExp {
  const cached = patternCache.get(token);
  if (cached) return cached;

  let pattern: RegExp;
  if (/^[a-z0-9][a-z0-9\-_.]*$/i.test(token)) {
    pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(token)}(?![a-z0-9])`, "i");
  } else {
    pattern = new RegExp(escapeRegex(token), "i");
  }
  patternCache.set(token, pattern);
  return pattern;
}

export function tokensOf(keyword: string): string[] {
  return keyword
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function alternativesOf(keyword: string): string[] {
  const parts = keyword
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [keyword.trim()];
}

export function canonicalOf(keyword: string): string {
  return alternativesOf(keyword)[0] || "";
}

function altMatch(alt: string, hay: string[]): [boolean, string[]] {
  const toks = tokensOf(alt);
  if (toks.length === 0) {
    return [false, []];
  }

  // 1) 整条短语命中
  const phrase = getTokenPattern(alt.trim().toLowerCase());
  if (hay.some((h) => phrase.test(h))) {
    return [true, []];
  }

  if (toks.length === 1) {
    return [false, toks];
  }

  // 2) 全部有效词分别命中
  const missed = toks.filter((t) => {
    const pat = getTokenPattern(t.toLowerCase());
    return !hay.some((h) => pat.test(h));
  });
  if (missed.length === 0) {
    return [true, []];
  }

  // 3) 连写形式命中：AI prompt → aiprompt
  const joined = toks.join("").toLowerCase();
  const joinedPat = getTokenPattern(joined);
  if (hay.some((h) => joinedPat.test(h))) {
    return [true, []];
  }

  return [false, missed];
}

export interface JudgeResult {
  relevance: ThreadsRadarRelevance;
  note: string;
}

/**
 * 三级相关性判定：blocked / relevant / offtopic
 */
export function judgeRelevance(
  post: { text?: string | null; tag?: string | null },
  keywords: string[],
  blocklist: string[],
): JudgeResult {
  const parts = [post.text || "", post.tag || ""];
  const raw = parts.join("\n");
  const hay = [raw, raw.replaceAll("#", "")];

  for (const term of blocklist) {
    if (!term || !term.trim()) continue;
    const pat = getTokenPattern(term.trim().toLowerCase());
    if (hay.some((h) => pat.test(h))) {
      return { relevance: "blocked", note: `命中屏蔽词「${term.trim()}」` };
    }
  }

  if (!keywords || keywords.length === 0) {
    return { relevance: "relevant", note: "" };
  }

  let bestNote = "";
  for (const kw of keywords) {
    const alts = alternativesOf(kw);
    for (const alt of alts) {
      const [ok, missed] = altMatch(alt, hay);
      if (ok) {
        const label = canonicalOf(kw);
        return {
          relevance: "relevant",
          note: alt === label ? `正文含「${label}」` : `正文含同义词「${alt}」`,
        };
      }
      if (missed && missed.length > 0) {
        bestNote = bestNote || `缺少「${missed[0]}」`;
      }
    }
    bestNote = bestNote || `正文未出现「${canonicalOf(kw)}」`;
  }

  return {
    relevance: "offtopic",
    note: bestNote || "正文未命中关键词",
  };
}

// ----------------------------------------------------------------- Authors

/**
 * 作者持续度分层（严格对齐 Python 原型）
 * core: 帖数 >= 3 且 爆款数 >= 2
 * steady: 帖数 >= 2
 * single_hit: 爆款数 >= 1 (且帖数 < 2)
 * casual: 其余
 */
export function getAuthorTier(posts: number, hits: number): ThreadsAuthorTier {
  if (posts >= 3 && hits >= 2) {
    return "core";
  }
  if (posts >= 2) {
    return "steady";
  }
  if (hits >= 1) {
    return "single_hit";
  }
  return "casual";
}

/**
 * 归一化用户名：支持粘贴 @username、带有前后斜杠、URL 等，统一小写
 */
export function normalizeThreadsUsername(raw: string): string {
  let s = (raw || "").trim();
  if (!s) return "";
  const low = s.toLowerCase();
  for (const host of ["threads.com/", "threads.net/"]) {
    if (low.includes(host)) {
      s = s.split(host)[1] || "";
      break;
    }
  }
  s = s.replace(/^@+/, "").trim();
  s = s.split("/")[0].split("?")[0].split("#")[0];
  return s.replace(/^@+/, "").replace(/\.+$/, "").trim().toLowerCase();
}

/**
 * 聚合单个作者的完整统计数据
 */
export function aggregateAuthorStats(
  username: string,
  posts: ThreadsRadarPost[],
): ThreadsAuthorAggregate {
  const totalPosts = posts.length;
  let likes = 0;
  let replies = 0;
  let reposts = 0;
  let quotes = 0;
  let hits = 0;
  let bestScore: number | null = null;
  let bestLikes = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  let verified = false;
  let newCount = 0;

  const categoryCounts = new Map<string, number>();
  const keywordCounts = new Map<string, number>();

  for (const p of posts) {
    likes += p.likeCount;
    replies += p.replyCount;
    reposts += p.repostCount;
    quotes += p.quoteCount;
    const inter = p.likeCount + p.replyCount + p.repostCount + p.quoteCount;
    if (inter >= HIT_THRESHOLD) {
      hits += 1;
    }
    if (bestScore === null || p.score > bestScore) {
      bestScore = p.score;
    }
    if (p.likeCount > bestLikes) {
      bestLikes = p.likeCount;
    }
    if (p.takenAt > 0) {
      if (firstAt === null || p.takenAt < firstAt) firstAt = p.takenAt;
      if (lastAt === null || p.takenAt > lastAt) lastAt = p.takenAt;
    }
    if (p.verified) verified = true;
    if (p.isNew) newCount += 1;

    if (p.category && p.category !== "未分组") {
      categoryCounts.set(p.category, (categoryCounts.get(p.category) || 0) + 1);
    }
    for (const kw of p.keywords || []) {
      const canonical = canonicalOf(kw);
      if (canonical) {
        keywordCounts.set(canonical, (keywordCounts.get(canonical) || 0) + 1);
      }
    }
  }

  const interactions = likes + replies + reposts + quotes;
  const hitRate = totalPosts > 0 ? Math.round((hits / totalPosts) * 100) / 100 : 0;
  const avgInteractions = totalPosts > 0 ? Math.round((interactions / totalPosts) * 10) / 10 : 0;

  const spanSeconds = firstAt !== null && lastAt !== null && lastAt > firstAt ? lastAt - firstAt : 0;
  const activeDays = spanSeconds > 0 ? Math.round((spanSeconds / 86400) * 10) / 10 : 0;
  const postsPerWeek =
    activeDays >= 1 ? Math.round(((totalPosts / activeDays) * 7) * 100) / 100 : null;

  const topCategories: ThreadsNamedCount[] = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));

  const topKeywords: ThreadsNamedCount[] = [...keywordCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([name, count]) => ({ name, count }));

  const tier = getAuthorTier(totalPosts, hits);
  const tierLabel = AUTHOR_TIER_LABELS[tier];

  return {
    username: normalizeThreadsUsername(username),
    posts: totalPosts,
    likes,
    replies,
    reposts,
    quotes,
    interactions,
    hits,
    hitRate,
    bestScore,
    bestLikes,
    firstAt,
    lastAt,
    activeDays,
    postsPerWeek,
    verified,
    newCount,
    topCategories,
    topKeywords,
    tier,
    tierLabel,
  };
}
