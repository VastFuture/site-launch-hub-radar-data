import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateRadarCollectionPayload, type RadarCollectionPayload } from "../../server/steam-radar-contract.ts";

export function parseArgs(argv = process.argv.slice(2)): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`未知参数: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`参数 ${key} 缺少值`);
    result.set(key.slice(2), value);
    index += 1;
  }
  return result;
}

export function requiredArg(args: Map<string, string>, name: string): string {
  const value = args.get(name);
  if (!value) throw new Error(`缺少必填参数 --${name}`);
  return value;
}

export async function readPayloadFile(path: string): Promise<{ raw: string; payload: RadarCollectionPayload; sha256: string }> {
  const raw = await readFile(path, "utf8");
  const payload = validateRadarCollectionPayload(JSON.parse(raw));
  const sha256 = createHash("sha256").update(raw).digest("hex");
  return { raw, payload, sha256 };
}

export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}
