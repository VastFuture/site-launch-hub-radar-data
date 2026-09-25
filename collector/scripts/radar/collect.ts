import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectSteamRadarData } from "../../server/steam-radar.ts";
import { validateRadarCollectionPayload } from "../../server/steam-radar-contract.ts";
import { parseArgs, requiredArg } from "./cli-utils.ts";

async function main(): Promise<void> {
  const args = parseArgs();
  const output = path.resolve(requiredArg(args, "output"));
  const scheduledAtRaw = args.get("scheduled-at") ?? process.env.RADAR_SCHEDULED_AT;
  const scheduledAt = scheduledAtRaw ? new Date(scheduledAtRaw) : new Date();
  if (Number.isNaN(scheduledAt.getTime())) throw new Error("--scheduled-at 必须是合法时间");
  const includeSearchEnrichment = process.env.RADAR_FORCE_ENRICHMENT === "true" || scheduledAt.getUTCHours() === 2;
  const payload = await collectSteamRadarData(fetch, {
    scheduledAt,
    collectorVersion: process.env.GITHUB_SHA ?? "local",
    serperApiKey: process.env.SERPER_API_KEY,
    includeSearchEnrichment,
  });
  validateRadarCollectionPayload(payload);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    output,
    runId: payload.runId,
    itemCount: payload.items.length,
    providerStatus: payload.providerStatus,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
