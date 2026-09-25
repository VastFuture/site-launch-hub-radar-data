import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs, readPayloadFile, requiredArg } from "./cli-utils.ts";

export interface SyncRadarOptions {
  payloadPath: string;
  sourceCommit: string;
  endpoint: string;
  secret: string;
}

export async function syncRadarToD1(options: SyncRadarOptions, fetcher: typeof fetch = fetch): Promise<unknown> {
  const { payloadPath, endpoint, secret } = options;
  const sourceCommit = options.sourceCommit.toLowerCase();
  if (!endpoint) throw new Error("缺少 --endpoint 或 RADAR_INGEST_URL");
  if (!secret) throw new Error("缺少 RADAR_INGEST_SECRET");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) throw new Error("source commit SHA 格式非法");
  const { raw, payload, sha256 } = await readPayloadFile(payloadPath);

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetcher(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "x-source-commit": sourceCommit,
          "x-payload-sha256": sha256,
        },
        body: raw,
        signal: AbortSignal.timeout(30_000),
      });
      const responseText = await response.text();
      if (response.ok) {
        return { runId: payload.runId, sourceCommit, payloadSha256: sha256, response: JSON.parse(responseText) };
      }
      if (response.status < 500 && response.status !== 429) {
        throw new Error(`D1 import rejected (${response.status}): ${responseText}`);
      }
      lastError = new Error(`D1 import transient failure (${response.status}): ${responseText}`);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith("D1 import rejected")) throw error;
    }
    if (attempt < 3) await delay(attempt * 2_000);
  }
  throw lastError instanceof Error ? lastError : new Error("D1 import failed");
}

async function main(): Promise<void> {
  const args = parseArgs();
  const result = await syncRadarToD1({
    payloadPath: requiredArg(args, "payload"),
    sourceCommit: requiredArg(args, "source-commit"),
    endpoint: args.get("endpoint") ?? process.env.RADAR_INGEST_URL ?? "",
    secret: process.env.RADAR_INGEST_SECRET ?? "",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
