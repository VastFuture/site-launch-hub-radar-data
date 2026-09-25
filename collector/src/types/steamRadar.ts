export type SteamRadarKind = "game" | "demo" | "dlc" | "soundtrack" | "unknown";
export type SteamRadarAction = "build" | "validate" | "watch" | "skip";

export interface SteamRadarTrendPoint {
  at: string;
  players: number | null;
  reviews: number | null;
  score: number;
}

export interface SteamRadarSerpResult {
  position: number;
  title: string;
  url: string;
  domain: string;
  category: "steam" | "social" | "big-media" | "wiki" | "specialist" | "other";
}

export interface SteamRadarItem {
  appId: string;
  title: string;
  url: string;
  capsuleUrl: string | null;
  releaseDate: string;
  releaseDateIso: string | null;
  daysSinceRelease: number | null;
  platforms: string[];
  tagIds: number[];
  kind: SteamRadarKind;
  priceLabel: string;
  isFree: boolean;
  discountPercent: number;
  reviewLabel: string | null;
  currentPlayers: number | null;
  playerDelta3h: number | null;
  reviewTotal: number | null;
  reviewDelta6h: number | null;
  evidenceCoverage: number;
  score: number;
  siteScore: number | null;
  confidenceScore: number;
  momentumScore: number | null;
  searchDemandScore: number | null;
  serpOpportunityScore: number | null;
  competitorCount: number | null;
  action: SteamRadarAction;
  confidence: "low" | "medium" | "high";
  signals: string[];
  reasonCodes: string[];
  missingEvidence: string[];
  keywordIdeas: string[];
  searchQueries: string[];
  matchedIntents: string[];
  serpProvider: string | null;
  serpResults: SteamRadarSerpResult[];
  trend14d: SteamRadarTrendPoint[];
  nextStep: string;
  watched: boolean;
}

export interface SteamRadarResponse {
  source: {
    name: "Steam Search";
    url: string;
    scope: string;
    providers: string[];
  };
  fetchedAt: string;
  total: number;
  historyStatus: "collecting" | "ready";
  scoring: {
    version: string;
    factors: string[];
  };
  limitations: string[];
  items: SteamRadarItem[];
}
