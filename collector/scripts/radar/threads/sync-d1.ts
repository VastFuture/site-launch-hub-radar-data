/**
 * Threads 雷达 D1 数据同步脚本
 * 读取采集生成的 payload 文件，计算 SHA256 校验和，并通过鉴权接口同步至 D1
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  validateThreadsRadarCollectionPayload,
  type ThreadsRadarCollectionPayload,
} from "../../../server/threads-radar-contract.ts";
import { parseArgs } from "./collector.ts";

export interface SyncThreadsRadarOptions {
  payloadPath: string;
  sourceCommit: string;
  endpoint: string;
  secret: string;
}

export interface SyncThreadsRadarResult {
  runId: string;
  sourceCommit: string;
  payloadSha256: string;
  response: unknown;
}

export async function readThreadsPayloadFile(
  path: string,
): Promise<{
  raw: string;
  payload: ThreadsRadarCollectionPayload;
  sha256: string;
}> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Payload 文件不是合法 JSON");
  }
  const payload = validateThreadsRadarCollectionPayload(parsed);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  return { raw, payload, sha256 };
}

export async function syncThreadsRadarToD1(
  options: SyncThreadsRadarOptions,
  fetcher: typeof fetch = fetch,
): Promise<SyncThreadsRadarResult> {
  const { payloadPath, endpoint, secret } = options;
  const sourceCommit = (options.sourceCommit || "").trim().toLowerCase();

  if (!endpoint) throw new Error("缺少 --endpoint 或 THREADS_RADAR_INGEST_URL");
  if (!secret) throw new Error("缺少 THREADS_RADAR_INGEST_SECRET");
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommit)) {
    throw new Error("source commit SHA 格式非法 (必须是 40 或 64 位十六进制字符)");
  }

  const { raw, payload, sha256 } = await readThreadsPayloadFile(payloadPath);

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
        let jsonResponse: unknown;
        try {
          jsonResponse = JSON.parse(responseText);
        } catch {
          jsonResponse = responseText;
        }
        return {
          runId: payload.runId,
          sourceCommit,
          payloadSha256: sha256,
          response: jsonResponse,
        };
      }

      if (response.status < 500 && response.status !== 429) {
        throw new Error(
          `D1 import rejected (${response.status}): ${responseText}`,
        );
      }
      lastError = new Error(
        `D1 import transient failure (${response.status}): ${responseText}`,
      );
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        error.message.startsWith("D1 import rejected")
      ) {
        throw error;
      }
    }

    if (attempt < 3) {
      await delay(attempt * 2_000);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("D1 import failed");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const payloadPath =
    args.get("payload") ?? "data/threads-radar/latest.json";
  const sourceCommit =
    args.get("source-commit") ?? process.env.GITHUB_SHA ?? "";
  const endpoint =
    args.get("endpoint") ?? process.env.THREADS_RADAR_INGEST_URL ?? "";
  const secret = process.env.THREADS_RADAR_INGEST_SECRET ?? "";

  const result = await syncThreadsRadarToD1({
    payloadPath,
    sourceCommit,
    endpoint,
    secret,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    // Redact secret if present
    const secret = process.env.THREADS_RADAR_INGEST_SECRET;
    let msg =
      error instanceof Error ? error.stack ?? error.message : String(error);
    if (secret) {
      msg = msg.replaceAll(secret, "***REDACTED***");
    }
    process.stderr.write(`${msg}\n`);
    process.exitCode = 1;
  });
}
