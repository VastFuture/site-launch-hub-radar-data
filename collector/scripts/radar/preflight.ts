import { appendFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type RadarStatusResponse =
  | {
      status: "EMPTY";
      latestRunId: null;
      latestSourceCommitSha: null;
      latestCollectedAt: null;
      latestImportedAt: null;
      ageMinutes: null;
      observedAt: string;
    }
  | {
      status: "IMPORTED";
      latestRunId: string;
      latestSourceCommitSha: string;
      latestCollectedAt: string;
      latestImportedAt: string;
      ageMinutes: number;
      observedAt: string;
    };

export interface RadarManifest {
  runId: string;
  collectedAt: string;
  payloadPath: string;
  payloadSha256: string;
}

export interface RadarAutomationDecision {
  action: "skip" | "replay" | "collect";
  reason: "no-evidence" | "git-ahead" | "fresh" | "fresh-drift" | "stale";
  drift: boolean;
  manifestCommit: string | null;
  payloadPath: string | null;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function parseRadarStatus(value: unknown): RadarStatusResponse {
  if (!value || typeof value !== "object") throw new Error("radar status must be an object");
  const status = value as Record<string, unknown>;
  if (status.status !== "EMPTY" && status.status !== "IMPORTED") {
    throw new Error("radar status value is invalid");
  }
  if (!validDate(status.observedAt)) throw new Error("radar status observedAt is invalid");
  if (status.status === "EMPTY") {
    for (const field of ["latestRunId", "latestSourceCommitSha", "latestCollectedAt", "latestImportedAt", "ageMinutes"]) {
      if (status[field] !== null) throw new Error(`EMPTY radar status ${field} must be null`);
    }
    return status as RadarStatusResponse;
  }
  if (typeof status.latestRunId !== "string" || !/^steam-radar:\d{4}-\d{2}-\d{2}T\d{2}$/.test(status.latestRunId)) {
    throw new Error("IMPORTED radar status latestRunId is invalid");
  }
  if (typeof status.latestSourceCommitSha !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(status.latestSourceCommitSha)) {
    throw new Error("IMPORTED radar status latestSourceCommitSha is invalid");
  }
  if (!validDate(status.latestCollectedAt)) throw new Error("radar status latestCollectedAt is invalid");
  if (!validDate(status.latestImportedAt)) throw new Error("radar status latestImportedAt is invalid");
  if (!Number.isFinite(status.ageMinutes) || Number(status.ageMinutes) < 0) {
    throw new Error("radar status ageMinutes is invalid");
  }
  return status as RadarStatusResponse;
}

function parseManifest(value: unknown): RadarManifest {
  if (!value || typeof value !== "object") throw new Error("radar manifest must be an object");
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.runId !== "string" || !/^steam-radar:\d{4}-\d{2}-\d{2}T\d{2}$/.test(manifest.runId)) {
    throw new Error("radar manifest runId is invalid");
  }
  if (!validDate(manifest.collectedAt)) throw new Error("radar manifest collectedAt is invalid");
  if (typeof manifest.payloadPath !== "string" || !/^steam\/runs\/[A-Za-z0-9._-]+\.json$/.test(manifest.payloadPath)) {
    throw new Error("radar manifest payloadPath is invalid");
  }
  if (typeof manifest.payloadSha256 !== "string" || !/^[0-9a-f]{64}$/.test(manifest.payloadSha256)) {
    throw new Error("radar manifest payloadSha256 is invalid");
  }
  return manifest as unknown as RadarManifest;
}

export function decideRadarAutomationAction(input: {
  status: RadarStatusResponse;
  manifest: RadarManifest | null;
  manifestCommit: string | null;
  minCollectionAgeMinutes: number;
}): RadarAutomationDecision {
  const { status, manifest, manifestCommit, minCollectionAgeMinutes } = input;
  if (!Number.isInteger(minCollectionAgeMinutes) || minCollectionAgeMinutes < 1) {
    throw new Error("min collection age must be a positive integer");
  }
  if ((manifest === null) !== (manifestCommit === null)) {
    throw new Error("radar manifest and manifest commit must either both exist or both be absent");
  }
  if (!manifest || !manifestCommit) {
    if (status.status === "EMPTY") {
      return { action: "collect", reason: "no-evidence", drift: false, manifestCommit: null, payloadPath: null };
    }
    return status.ageMinutes < minCollectionAgeMinutes
      ? { action: "skip", reason: "fresh", drift: false, manifestCommit: null, payloadPath: null }
      : { action: "collect", reason: "stale", drift: false, manifestCommit: null, payloadPath: null };
  }

  const manifestTime = Date.parse(manifest.collectedAt);
  const gitAhead = status.status === "EMPTY" || (
    manifest.runId !== status.latestRunId && manifestTime > Date.parse(status.latestCollectedAt)
  );
  if (gitAhead) {
    return {
      action: "replay", reason: "git-ahead", drift: false,
      manifestCommit, payloadPath: manifest.payloadPath,
    };
  }

  const drift = manifest.runId === status.latestRunId && manifestCommit !== status.latestSourceCommitSha;
  if (status.status === "IMPORTED" && status.ageMinutes < minCollectionAgeMinutes) {
    return {
      action: "skip", reason: drift ? "fresh-drift" : "fresh", drift,
      manifestCommit, payloadPath: manifest.payloadPath,
    };
  }
  return {
    action: "collect", reason: "stale", drift,
    manifestCommit, payloadPath: manifest.payloadPath,
  };
}

async function main(): Promise<void> {
  const endpoint = process.env.RADAR_STATUS_URL?.trim() ?? "";
  const secret = process.env.RADAR_INGEST_SECRET ?? "";
  const output = process.env.GITHUB_OUTPUT?.trim() ?? "";
  const workspace = process.env.GITHUB_WORKSPACE?.trim() || process.cwd();
  const minCollectionAgeMinutes = Number(process.env.RADAR_MIN_COLLECTION_AGE_MINUTES ?? "55");
  if (!endpoint || !secret || !output) {
    throw new Error("RADAR_STATUS_URL, RADAR_INGEST_SECRET and GITHUB_OUTPUT are required");
  }

  const response = await fetch(endpoint, {
    headers: {
      authorization: `Bearer ${secret}`,
      "user-agent": "SiteLaunchHub-Radar-Actions/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Radar status failed (${response.status}): ${(await response.text()).slice(0, 500)}`);
  }
  const status = parseRadarStatus(await response.json());

  const manifestPath = path.join(workspace, "manifests/latest.json");
  let manifest: RadarManifest | null = null;
  let manifestCommit: string | null = null;
  try {
    manifest = parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
    manifestCommit = execFileSync(
      "git",
      ["log", "-1", "--format=%H", "--", "manifests/latest.json"],
      { cwd: workspace, encoding: "utf8" },
    ).trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const decision = decideRadarAutomationAction({
    status,
    manifest,
    manifestCommit,
    minCollectionAgeMinutes,
  });
  const outputs = {
    action: decision.action,
    reason: decision.reason,
    drift: String(decision.drift),
    manifest_commit: decision.manifestCommit ?? "",
    payload_path: decision.payloadPath ?? "",
  };
  await appendFile(output, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""), "utf8");
  process.stdout.write(`${JSON.stringify({ status, decision })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
