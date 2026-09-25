import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { jsonLine, parseArgs, readPayloadFile, requiredArg } from "./cli-utils.ts";

export interface PersistRadarDataResult {
  runId: string;
  payloadPath: string;
  payloadSha256: string;
}

export async function persistRadarData(payloadFile: string, repositoryDirectory: string): Promise<PersistRadarDataResult> {
  const payloadPath = path.resolve(payloadFile);
  const repository = path.resolve(repositoryDirectory);
  const { raw, payload, sha256 } = await readPayloadFile(payloadPath);
  const collectedAt = new Date(payload.collectedAt);
  const date = payload.collectedAt.slice(0, 10);
  const runFileName = payload.collectedAt.replace(/:/g, "-").replace(/\.\d{3}Z$/, "Z");
  const relativeRunPath = path.posix.join("steam", "runs", `${runFileName}.json`);
  const runPath = path.join(repository, relativeRunPath);
  const latestPath = path.join(repository, "steam", "latest.json");
  const snapshotPath = path.join(repository, "steam", "snapshots", `${date}.ndjson`);
  const manifestPath = path.join(repository, "manifests", "latest.json");
  const schemaTarget = path.join(repository, "schema", "steam-radar-data-v1.schema.json");

  await Promise.all([
    mkdir(path.dirname(runPath), { recursive: true }),
    mkdir(path.dirname(snapshotPath), { recursive: true }),
    mkdir(path.dirname(manifestPath), { recursive: true }),
    mkdir(path.dirname(schemaTarget), { recursive: true }),
  ]);
  await writeFile(runPath, raw, "utf8");
  await writeFile(latestPath, raw, "utf8");
  await copyFile(path.resolve("schemas/steam-radar-data-v1.schema.json"), schemaTarget);

  let existingSnapshots = "";
  try { existingSnapshots = await readFile(snapshotPath, "utf8"); } catch { /* first run of the day */ }
  const hasRun = existingSnapshots.split("\n").some((line) => line.includes(`\"runId\":\"${payload.runId}\"`));
  if (!hasRun) {
    const lines = payload.items.flatMap((item) => item.live ? [jsonLine({
      schemaVersion: payload.schemaVersion,
      runId: payload.runId,
      collectedAt: payload.collectedAt,
      appId: item.game.appId,
      currentPlayers: item.live.currentPlayers,
      reviewTotal: item.live.reviewTotal,
      reviewPositive: item.live.reviewPositive,
      reviewNegative: item.live.reviewNegative,
      score: item.game.score,
    })] : []);
    await writeFile(snapshotPath, `${existingSnapshots}${lines.join("")}`, "utf8");
  }

  const manifest = {
    schemaVersion: payload.schemaVersion,
    runId: payload.runId,
    scheduledAt: payload.scheduledAt,
    collectedAt: payload.collectedAt,
    collectorVersion: payload.collectorVersion,
    payloadPath: relativeRunPath,
    payloadSha256: sha256,
    gameCount: payload.items.length,
    snapshotCount: payload.items.filter((item) => item.live && (
      item.live.currentPlayers !== null || item.live.reviewTotal !== null
    )).length,
    providerStatus: payload.providerStatus,
    generatedAt: collectedAt.toISOString(),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { runId: payload.runId, payloadPath: relativeRunPath, payloadSha256: sha256 };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const result = await persistRadarData(requiredArg(args, "payload"), requiredArg(args, "repo"));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
