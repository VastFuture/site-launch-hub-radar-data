/**
 * 统一 HTTP 错误与响应助手。
 * 业务 API 错误只暴露最小信息，不泄露资源存在性细节（跨租户一律 404）。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** 结构化附加信息（如软门禁阻断原因清单），随错误响应返回 */
  readonly details?: unknown;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(
  data: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    const body: Record<string, unknown> = {
      error: { code: err.code, message: err.message },
    };
    if (err.details !== undefined) {
      (body.error as Record<string, unknown>).details = err.details;
    }
    return json(body, err.status);
  }
  // Zod 校验错误 → 400
  if (err && typeof err === "object" && "issues" in err) {
    return json(
      { error: { code: "invalid_payload", message: "请求体校验失败" } },
      400,
    );
  }
  console.error("[api] 未处理错误:", err);
  return json(
    { error: { code: "internal_error", message: "Internal server error" } },
    500,
  );
}

/** 读取并解析 JSON body，带大小上限（导入 payload 最大 512KB） */
export async function readJsonBody(
  request: Request,
  maxBytes = 512 * 1024,
): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > maxBytes) {
    throw new ApiError(413, "payload_too_large", "请求体过大");
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw new ApiError(413, "payload_too_large", "请求体过大");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "请求体不是合法 JSON");
  }
}
