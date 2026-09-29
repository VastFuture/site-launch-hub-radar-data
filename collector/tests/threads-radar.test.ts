import { test } from "node:test";
import assert from "node:assert";
import { validateThreadsRadarCollectionPayload } from "../server/threads-radar-contract.ts";
import { parseKeywordsText } from "../scripts/radar/threads/collector.ts";
import { syncThreadsRadarToD1 } from "../scripts/radar/threads/sync-d1.ts";
import { writeFile, unlink } from "node:fs/promises";

test("Contract payload validation", () => {
  const validPayload = {
    schemaVersion: "threads-radar-data-v1",
    runId: "threads-radar:2026-09-29T00:00:00.000Z",
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

  const validated = validateThreadsRadarCollectionPayload(validPayload);
  assert.strictEqual(validated.schemaVersion, "threads-radar-data-v1");
  assert.strictEqual(validated.items.length, 1);
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

test("Sync headers", async () => {
  const payloadPath = "/tmp/test-payload.json";
  const rawPayload = JSON.stringify({
    schemaVersion: "threads-radar-data-v1",
    runId: "threads-radar:2026-09-29T00:00:00.000Z",
    scheduledAt: "2026-09-29T00:00:00.000Z",
    collectedAt: "2026-09-29T00:00:00.000Z",
    collectorVersion: "test",
    source: {
      name: "Threads Public Search",
      url: "https://www.threads.com",
      scope: "threads-search-radar",
    },
    items: []
  });
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
