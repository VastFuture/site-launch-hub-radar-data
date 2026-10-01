import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  THREADS_RADAR_MANUAL_MARKER,
  validateThreadsRadarCollectionPayload,
} from "../server/threads-radar-contract.ts";
import {
  collectThreadsRadarData,
  parseArgs,
  parseKeywordsText,
} from "../scripts/radar/threads/collector.ts";
import { syncThreadsRadarToD1 } from "../scripts/radar/threads/sync-d1.ts";

const TEST_UUID = "123e4567-e89b-12d3-a456-426614174000";

function makePayload(runId: string) {
  return {
    schemaVersion: "threads-radar-data-v1",
    runId,
    scheduledAt: "2026-09-29T00:00:00.000Z",
    collectedAt: "2026-09-29T00:00:00.000Z",
    collectorVersion: "test",
    source: {
      name: "Threads Public Search",
      url: "https://www.threads.com",
      scope: "threads-search-radar",
    },
    items: [
      {
        post: {
          code: "test1",
          url: "https://www.threads.com/@test/post/test1",
          username: "test",
          userId: "123",
          verified: true,
          text: "Hello",
          lang: "en",
          likeCount: 10,
          replyCount: 5,
          repostCount: 2,
          quoteCount: 1,
          takenAt: 123456789,
          mediaType: null,
          hasImage: false,
          thumb: null,
          isReply: false,
          tag: "tag",
          keywords: ["test"],
          category: "test",
          relevance: "relevant",
          relevanceNote: "",
          score: 1.5,
          velocity: 0.5,
        }
      }
    ]
  };
}

test("Contract payload validation", () => {
  const validated = validateThreadsRadarCollectionPayload(
    makePayload("threads-radar:2026-09-29T00:00:00.000Z"),
  );
  assert.strictEqual(validated.schemaVersion, "threads-radar-data-v1");
  assert.strictEqual(validated.items.length, 1);
});

test("Contract accepts manual-v1 marker runId", () => {
  assert.strictEqual(THREADS_RADAR_MANUAL_MARKER, "manual-v1");
  const validated = validateThreadsRadarCollectionPayload(
    makePayload(`threads-radar:manual:${TEST_UUID}`),
  );
  assert.strictEqual(validated.runId, `threads-radar:manual:${TEST_UUID}`);
});

test("Contract rejects malformed manual runId", () => {
  assert.throws(
    () =>
      validateThreadsRadarCollectionPayload(
        makePayload("threads-radar:manual:not-a-uuid"),
      ),
    /runId/,
  );
});

test("Keyword parsing and request pressure calculation", () => {
  const content = `
[group1] keyword1
keyword2
[group2] keyword3
  `;
  const parsed = parseKeywordsText(content);
  assert.strictEqual(parsed.length, 3);
  assert.strictEqual(parsed[0].group, "group1");
  assert.strictEqual(parsed[0].keyword, "keyword1");
  assert.strictEqual(parsed[1].group, "group1");
  assert.strictEqual(parsed[1].keyword, "keyword2");
  assert.strictEqual(parsed[2].group, "group2");
  assert.strictEqual(parsed[2].keyword, "keyword3");
});

test("parseArgs captures --dispatch-id", () => {
  const args = parseArgs(["--dispatch-id", TEST_UUID]);
  assert.strictEqual(args.get("dispatch-id"), TEST_UUID);
});

const emptyFetcher = async () => new Response("", { status: 200 });

const collectOptions = {
  keywords: ["ai"],
  blocklist: [],
  variants: ["base"],
  scheduledAt: new Date("2026-09-29T00:00:00.000Z"),
  collectorVersion: "test",
  skipJitter: true,
};

test("collectThreadsRadarData emits manual runId for dispatchId", async () => {
  const payload = await collectThreadsRadarData(emptyFetcher, {
    ...collectOptions,
    dispatchId: TEST_UUID,
  });
  assert.strictEqual(payload.runId, `threads-radar:manual:${TEST_UUID}`);
});

test("collectThreadsRadarData keeps ISO runId without dispatchId", async () => {
  const payload = await collectThreadsRadarData(emptyFetcher, collectOptions);
  assert.strictEqual(payload.runId, "threads-radar:2026-09-29T00:00:00.000Z");
});

test("collectThreadsRadarData rejects invalid dispatchId", async () => {
  await assert.rejects(
    async () =>
      collectThreadsRadarData(emptyFetcher, {
        ...collectOptions,
        dispatchId: "not-a-uuid",
      }),
    /UUID/,
  );
});

test("Workflow wires manual dispatch contract", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const workflow = readFileSync(
    path.resolve(here, "../../.github/workflows/threads-radar-scheduled.yml"),
    "utf8",
  );

  assert.ok(
    workflow.includes("run-name: Threads radar ${{ inputs.dispatch_id || github.run_id }}"),
    "run name must fall back to github.run_id when dispatch_id is absent",
  );
  assert.ok(
    workflow.includes("dispatch_id:"),
    "workflow_dispatch must expose an optional dispatch_id input",
  );
  assert.ok(
    workflow.includes("THREADS_RADAR_DISPATCH_CONTRACT: manual-v1"),
    "workflow must expose the immutable manual-v1 contract marker",
  );
  assert.ok(
    workflow.includes("--dispatch-id"),
    "collect step must forward dispatch_id to the collector CLI",
  );
  assert.ok(
    workflow.includes("threads-radar:manual:"),
    "sync step must assert the manual runId before D1 sync",
  );
  assert.ok(
    workflow.includes("collect_only"),
    "collect_only must still gate the D1 sync step",
  );
});

test("Sync headers", async () => {
  const payloadPath = "/tmp/test-payload.json";
  const rawPayload = JSON.stringify(
    makePayload("threads-radar:2026-09-29T00:00:00.000Z"),
  );
  await writeFile(payloadPath, rawPayload, "utf8");

  try {
    let capturedRequest: Request | undefined;
    const dummyFetcher = async (url: string | URL | Request, init?: RequestInit) => {
      capturedRequest = new Request(url, init);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const options = {
      payloadPath,
      sourceCommit: "1234567890123456789012345678901234567890",
      endpoint: "https://example.com/ingest",
      secret: "test-secret"
    };

    const result = await syncThreadsRadarToD1(options, dummyFetcher as typeof fetch);

    assert.strictEqual(capturedRequest?.headers.get("authorization"), "Bearer test-secret");
    assert.strictEqual(capturedRequest?.headers.get("x-source-commit"), "1234567890123456789012345678901234567890");
    assert.ok(capturedRequest?.headers.get("x-payload-sha256"));

  } finally {
    await unlink(payloadPath);
  }
});
