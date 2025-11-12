interface Env {
  DEFAULT_TEST_DOMAIN?: string;
  REQUEST_TIMEOUT_MS?: string;
}

type DohStatus = "success" | "failure" | "partial_match";

type Mode = "doh" | "ech";

type ProviderKey = "target" | "cloudflare" | "google";

type DohResponseFormat = "json" | "wire" | "text" | "unknown";

interface DohProviderResult {
  status: number | null;
  ok: boolean;
  ips: string[];
  latency_ms: number | null;
  attempted_formats: DohRequestMode[];
  response_format?: DohResponseFormat;
  content_type?: string | null;
  raw?: unknown;
  error?: string;
}

interface DohApiResponse {
  status: DohStatus;
  message: string;
  details: Record<ProviderKey, DohProviderResult>;
  comparison: {
    matches_cloudflare: boolean;
    matches_google: boolean;
  };
}

interface EchProviderResult {
  found: boolean;
  record?: string;
  status: number | null;
  latency_ms: number | null;
  attempted_formats: DohRequestMode[];
  response_format?: DohResponseFormat;
  content_type?: string | null;
  error?: string;
  raw?: unknown;
}

interface EchApiResponse {
  ech_enabled: boolean;
  message: string;
  providers: Record<Exclude<ProviderKey, "target">, EchProviderResult>;
}

type DohProviderConfig = {
  key: ProviderKey;
  endpoint: string;
};

type DohRequestMode = "json" | "wire";

const CLOUDFLARE_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const GOOGLE_DOH_ENDPOINT = "https://dns.google/resolve";
const HTTPS_RECORD_TYPE = 65;
const DEFAULT_TIMEOUT_MS = 5000;
const TEXT_HEADERS = { "Content-Type": "text/html; charset=utf-8" };
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  if (url.pathname === "/" && request.method === "GET") {
    return withCors(new Response(HTML_PAGE, { headers: TEXT_HEADERS }));
  }

  if (url.pathname === "/api/check" && request.method === "POST") {
    try {
      const body = await request.json<{ mode?: string; target?: string }>();
      const mode = body.mode as Mode | undefined;
      const target = (body.target ?? "").trim();

      if (!mode || (mode !== "doh" && mode !== "ech")) {
        return createErrorResponse("mode 参数必须是 'doh' 或 'ech'", 400);
      }

      if (!target) {
        return createErrorResponse("target 参数不能为空", 400);
      }

      const timeout = resolveTimeout(env.REQUEST_TIMEOUT_MS);
      const testDomain = env.DEFAULT_TEST_DOMAIN?.trim() || "example.com";

      if (mode === "doh") {
        const result = await runDohCheck(target, testDomain, timeout);
        return createJsonResponse(result);
      }

      const result = await runEchCheck(target, timeout);
      return createJsonResponse(result);
    } catch (error) {
      const message = error instanceof SyntaxError ? "请求体不是有效的 JSON" : "服务器内部错误";
      const status = error instanceof SyntaxError ? 400 : 500;
      return createErrorResponse(message, status, error);
    }
  }

  return createErrorResponse("未找到对应的路由", 404);
}

function resolveTimeout(timeoutSetting?: string): number {
  if (!timeoutSetting) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(timeoutSetting);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

async function runDohCheck(targetUrl: string, testDomain: string, timeout: number): Promise<DohApiResponse> {
  const providers: DohProviderConfig[] = [
    { key: "target", endpoint: targetUrl },
    { key: "cloudflare", endpoint: CLOUDFLARE_DOH_ENDPOINT },
    { key: "google", endpoint: GOOGLE_DOH_ENDPOINT },
  ];

  const fetchPromises = providers.map(({ key, endpoint }) =>
    fetchDohAnswer(endpoint, testDomain, "A", timeout).then((result) => ({ key, result }))
  );

  const settled = await Promise.allSettled(fetchPromises);

  const details = Object.fromEntries(
    settled.map((entry, index) => {
      const key = providers[index].key;
      if (entry.status === "fulfilled") {
        return [key, entry.value.result];
      }
      return [key, {
        status: null,
        ok: false,
        ips: [],
        latency_ms: null,
        attempted_formats: [],
        response_format: "unknown",
        content_type: null,
        error: normalizeErrorMessage(entry.reason),
      } satisfies DohProviderResult];
    })
  ) as Record<ProviderKey, DohProviderResult>;

  const targetResult = details.target;
  const cloudflareResult = details.cloudflare;
  const googleResult = details.google;

  const matchesCloudflare = targetResult.ok && cloudflareResult.ok && setsAreEqual(new Set(targetResult.ips), new Set(cloudflareResult.ips));
  const matchesGoogle = targetResult.ok && googleResult.ok && setsAreEqual(new Set(targetResult.ips), new Set(googleResult.ips));

  let status: DohStatus = "failure";
  let message = "目标 DoH 服务未返回有效结果。";

  if (!targetResult.ok) {
    status = "failure";
    message = targetResult.error ?? "目标 DoH 服务查询失败。";
  } else if (matchesCloudflare && matchesGoogle) {
    status = "success";
    message = "目标 DoH 服务返回的结果与 Cloudflare 和 Google 完全一致。";
  } else if (matchesCloudflare || matchesGoogle) {
    status = "partial_match";
    message = matchesCloudflare
      ? "目标 DoH 服务与 Cloudflare 结果一致，但与 Google 不完全一致。"
      : "目标 DoH 服务与 Google 结果一致，但与 Cloudflare 不完全一致。";
  } else {
    status = "failure";
    message = "目标 DoH 服务返回的结果与 Cloudflare 和 Google 均不一致。";
  }

  return {
    status,
    message,
    details,
    comparison: {
      matches_cloudflare: matchesCloudflare,
      matches_google: matchesGoogle,
    },
  };
}

async function runEchCheck(domain: string, timeout: number): Promise<EchApiResponse> {
  const providers: Array<{ key: "cloudflare" | "google"; endpoint: string }> = [
    { key: "cloudflare", endpoint: CLOUDFLARE_DOH_ENDPOINT },
    { key: "google", endpoint: GOOGLE_DOH_ENDPOINT },
  ];

  const fetchPromises = providers.map(({ key, endpoint }) =>
    fetchHttpsRecord(endpoint, domain, timeout).then((result) => ({ key, result }))
  );

  const settled = await Promise.allSettled(fetchPromises);

  const providerResults = Object.fromEntries(
    settled.map((entry, index) => {
      const key = providers[index].key;
      if (entry.status === "fulfilled") {
        return [key, entry.value.result];
      }
      return [key, {
        found: false,
        record: undefined,
        status: null,
        latency_ms: null,
        attempted_formats: [],
        response_format: "unknown",
        content_type: null,
        error: normalizeErrorMessage(entry.reason),
      } satisfies EchProviderResult];
    })
  ) as EchApiResponse["providers"];

  const echEnabled = Object.values(providerResults).some((provider) => provider.found);

  const message = echEnabled
    ? "检测到 HTTPS 记录包含 ECH 参数，推测该域名已启用 ECH。"
    : "未在权威 DoH 服务的 HTTPS 记录中发现 ECH 参数，可能未启用 ECH。";

  return {
    ech_enabled: echEnabled,
    message,
    providers: providerResults,
  };
}

async function fetchDohAnswer(endpoint: string, name: string, recordType: string, timeout: number): Promise<DohProviderResult> {
  const attempts: DohProviderResult[] = [];

  const jsonAttempt = await performDohRequest(endpoint, name, recordType, timeout, "json");
  if (jsonAttempt) {
    if (jsonAttempt.ok) return jsonAttempt;
    attempts.push(jsonAttempt);
  }

  const wireAttempt = await performDohRequest(endpoint, name, recordType, timeout, "wire");
  if (wireAttempt) {
    if (wireAttempt.ok) return wireAttempt;
    attempts.push(wireAttempt);
  }

  if (attempts.length > 0) {
    return combineDohFailures(attempts);
  }

  return {
    status: null,
    ok: false,
    ips: [],
    latency_ms: null,
    attempted_formats: [],
    response_format: "unknown",
    content_type: null,
    error: "无法完成 DoH 查询。",
  };
}

async function performDohRequest(endpoint: string, name: string, recordType: string, timeout: number, mode: DohRequestMode): Promise<DohProviderResult> {
  let url: URL;
  try {
    url = mode === "json" ? buildDohJsonUrl(endpoint, name, recordType) : buildDohWireUrl(endpoint, name, recordType);
  } catch (error) {
    return {
      status: null,
      ok: false,
      ips: [],
      latency_ms: null,
      attempted_formats: [mode],
      response_format: "unknown",
      content_type: null,
      error: normalizeErrorMessage(error),
    };
  }

  const headers: HeadersInit = mode === "json"
    ? { Accept: "application/dns-json" }
    : { Accept: "application/dns-message" };

  const started = Date.now();
  try {
    const response = await fetch(url.toString(), {
      headers,
      signal: createTimeoutSignal(timeout),
    });
    const latency_ms = Date.now() - started;
    const status = response.status;
    const contentType = response.headers.get("content-type");

    if (isJsonContentType(contentType)) {
      try {
        const json = await response.json();
        const ips = extractIpsFromAnswer(json);
        const ok = response.ok && ips.length > 0;
        return {
          status,
          ok,
          ips,
          latency_ms,
          attempted_formats: [mode],
          response_format: "json",
          content_type: contentType,
          raw: json,
          error: ok ? undefined : "未在响应中找到有效的 A 记录。",
        };
      } catch (error) {
        return {
          status,
          ok: false,
          ips: [],
          latency_ms,
          attempted_formats: [mode],
          response_format: "json",
          content_type: contentType,
          raw: null,
          error: `解析 JSON 响应失败：${normalizeErrorMessage(error)}`,
        };
      }
    }

    if (isTextContentType(contentType)) {
      const text = await response.text();
      const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      return {
        status,
        ok: false,
        ips: [],
        latency_ms,
        attempted_formats: [mode],
        response_format: "text",
        content_type: contentType,
        raw: snippet,
        error: snippet ? `服务器返回文本响应：${snippet}` : "服务器返回了文本响应。",
      };
    }

    const buffer = await response.arrayBuffer();
    const raw = createDnsMessageRaw(buffer, contentType);

    try {
      const ips = extractIpsFromDnsMessage(buffer);
      const ok = response.ok && ips.length > 0;
      return {
        status,
        ok,
        ips,
        latency_ms,
        attempted_formats: [mode],
        response_format: "wire",
        content_type: contentType,
        raw,
        error: ok ? undefined : "未在响应中找到有效的 A/AAAA 记录。",
      };
    } catch (error) {
      return {
        status,
        ok: false,
        ips: [],
        latency_ms,
        attempted_formats: [mode],
        response_format: "wire",
        content_type: contentType,
        raw,
        error: `解析 DNS 二进制报文失败：${normalizeErrorMessage(error)}`,
      };
    }
  } catch (error) {
    return {
      status: null,
      ok: false,
      ips: [],
      latency_ms: null,
      attempted_formats: [mode],
      response_format: "unknown",
      content_type: null,
      error: normalizeErrorMessage(error),
    };
  }
}

async function fetchHttpsRecord(endpoint: string, domain: string, timeout: number): Promise<EchProviderResult> {
  const attempts: EchProviderResult[] = [];

  const jsonAttempt = await performHttpsRequest(endpoint, domain, timeout, "json");
  if (jsonAttempt) {
    if (jsonAttempt.found) return jsonAttempt;
    attempts.push(jsonAttempt);
  }

  const wireAttempt = await performHttpsRequest(endpoint, domain, timeout, "wire");
  if (wireAttempt) {
    if (wireAttempt.found) return wireAttempt;
    attempts.push(wireAttempt);
  }

  if (attempts.length > 0) {
    return combineEchFailures(attempts);
  }

  return {
    found: false,
    record: undefined,
    status: null,
    latency_ms: null,
    attempted_formats: [],
    response_format: "unknown",
    content_type: null,
    error: "无法完成 HTTPS 记录查询。",
  };
}

async function performHttpsRequest(endpoint: string, domain: string, timeout: number, mode: DohRequestMode): Promise<EchProviderResult> {
  let url: URL;
  try {
    url = mode === "json"
      ? buildDohJsonUrl(endpoint, domain, String(HTTPS_RECORD_TYPE))
      : buildDohWireUrl(endpoint, domain, String(HTTPS_RECORD_TYPE));
  } catch (error) {
    return {
      found: false,
      record: undefined,
      status: null,
      latency_ms: null,
      attempted_formats: [mode],
      response_format: "unknown",
      content_type: null,
      error: normalizeErrorMessage(error),
    };
  }

  const headers: HeadersInit = mode === "json"
    ? { Accept: "application/dns-json" }
    : { Accept: "application/dns-message" };

  const started = Date.now();
  try {
    const response = await fetch(url.toString(), {
      headers,
      signal: createTimeoutSignal(timeout),
    });
    const latency_ms = Date.now() - started;
    const status = response.status;
    const contentType = response.headers.get("content-type");

    if (isJsonContentType(contentType)) {
      try {
        const json = await response.json();
        const record = extractHttpsRecord(json);
        const found = Boolean(record && record.includes("ech="));
        return {
          found,
          record: record ?? undefined,
          status,
          latency_ms,
          attempted_formats: [mode],
          response_format: "json",
          content_type: contentType,
          raw: json,
          error: found ? undefined : "未发现包含 ECH 参数的 HTTPS 记录。",
        };
      } catch (error) {
        return {
          found: false,
          record: undefined,
          status,
          latency_ms,
          attempted_formats: [mode],
          response_format: "json",
          content_type: contentType,
          raw: null,
          error: `解析 JSON 响应失败：${normalizeErrorMessage(error)}`,
        };
      }
    }

    if (isTextContentType(contentType)) {
      const text = await response.text();
      const snippet = text.length > 200 ? `${text.slice(0, 200)}…` : text;
      return {
        found: false,
        record: undefined,
        status,
        latency_ms,
        attempted_formats: [mode],
        response_format: "text",
        content_type: contentType,
        raw: snippet,
        error: snippet ? `服务器返回文本响应：${snippet}` : "服务器返回了文本响应。",
      };
    }

    const buffer = await response.arrayBuffer();
    const raw = createDnsMessageRaw(buffer, contentType);

    try {
      const { found, record, error } = findHttpsRecordInDnsMessage(buffer);
      return {
        found,
        record: record ?? undefined,
        status,
        latency_ms,
        attempted_formats: [mode],
        response_format: "wire",
        content_type: contentType,
        raw,
        error: found ? undefined : error ?? "未发现包含 ECH 参数的 HTTPS 记录。",
      };
    } catch (error) {
      return {
        found: false,
        record: undefined,
        status,
        latency_ms,
        attempted_formats: [mode],
        response_format: "wire",
        content_type: contentType,
        raw,
        error: `解析 DNS 二进制报文失败：${normalizeErrorMessage(error)}`,
      };
    }
  } catch (error) {
    return {
      found: false,
      record: undefined,
      status: null,
      latency_ms: null,
      attempted_formats: [mode],
      response_format: "unknown",
      content_type: null,
      error: normalizeErrorMessage(error),
    };
  }
}

function buildDohJsonUrl(endpoint: string, name: string, type: string): URL {
  const url = new URL(endpoint);
  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  return url;
}

function buildDohWireUrl(endpoint: string, name: string, type: string): URL {
  const recordType = recordTypeToNumber(type);
  const hostname = normalizeDomain(name);
  const query = buildDnsQueryMessage(hostname, recordType);
  const url = new URL(endpoint);
  url.searchParams.delete("name");
  url.searchParams.delete("type");
  url.searchParams.set("dns", bytesToBase64Url(query));
  return url;
}

function combineDohFailures(results: DohProviderResult[]): DohProviderResult {
  const merged = { ...results[results.length - 1] };
  merged.attempted_formats = Array.from(
    new Set(results.flatMap((item) => item.attempted_formats ?? [])),
  );
  if (!merged.response_format || merged.response_format === "unknown") {
    const responseFormat = results.map((item) => item.response_format).find((format) => format && format !== "unknown");
    if (responseFormat) {
      merged.response_format = responseFormat;
    }
  }
  if (!merged.content_type) {
    merged.content_type = results.map((item) => item.content_type).find((type) => Boolean(type)) ?? null;
  }
  if (merged.status === null) {
    for (const item of [...results].reverse()) {
      if (item.status !== null) {
        merged.status = item.status;
        break;
      }
    }
  }
  if (merged.latency_ms === null) {
    for (const item of [...results].reverse()) {
      if (item.latency_ms !== null) {
        merged.latency_ms = item.latency_ms;
        break;
      }
    }
  }
  const errors = results.map((item) => item.error).filter(Boolean) as string[];
  merged.error = errors.length > 0 ? errors.join(" | ") : "DoH 查询失败。";
  merged.ips = Array.from(new Set(results.flatMap((item) => item.ips)));
  merged.ok = merged.ips.length > 0 && (merged.status ?? 0) >= 200 && (merged.status ?? 0) < 400;
  return merged;
}

function combineEchFailures(results: EchProviderResult[]): EchProviderResult {
  const merged = { ...results[results.length - 1] };
  if (merged.status === null) {
    for (const item of [...results].reverse()) {
      if (item.status !== null) {
        merged.status = item.status;
        break;
      }
    }
  }
  if (merged.latency_ms === null) {
    for (const item of [...results].reverse()) {
      if (item.latency_ms !== null) {
        merged.latency_ms = item.latency_ms;
        break;
      }
    }
  }
  merged.attempted_formats = Array.from(
    new Set(results.flatMap((item) => item.attempted_formats ?? [])),
  );
  if (!merged.response_format || merged.response_format === "unknown") {
    const responseFormat = results.map((item) => item.response_format).find((format) => format && format !== "unknown");
    if (responseFormat) {
      merged.response_format = responseFormat;
    }
  }
  if (!merged.content_type) {
    merged.content_type = results.map((item) => item.content_type).find((type) => Boolean(type)) ?? null;
  }
  const errors = results.map((item) => item.error).filter(Boolean) as string[];
  merged.error = errors.length > 0 ? errors.join(" | ") : "HTTPS 记录查询失败。";
  merged.found = results.some((item) => item.found);
  merged.record = results.map((item) => item.record).find((record) => Boolean(record));
  return merged;
}

function buildDnsQueryMessage(domain: string, recordType: number): Uint8Array {
  const labels = domain ? domain.split(".") : [];
  let length = 12 + 1 + 4; // header + terminator + qtype/qclass
  for (const label of labels) {
    if (!label) continue;
    if (label.length > 63) {
      throw new Error(`域名标签过长: ${label}`);
    }
    length += 1 + label.length;
  }

  const buffer = new Uint8Array(length);
  const view = new DataView(buffer.buffer);

  const id = generateRequestId();
  view.setUint16(0, id);
  view.setUint16(2, 0x0100); // recursion desired
  view.setUint16(4, 1); // QDCOUNT
  view.setUint16(6, 0); // ANCOUNT
  view.setUint16(8, 0); // NSCOUNT
  view.setUint16(10, 0); // ARCOUNT

  let offset = 12;
  for (const label of labels) {
    if (!label) continue;
    buffer[offset] = label.length;
    offset += 1;
    for (let i = 0; i < label.length; i += 1) {
      buffer[offset + i] = label.charCodeAt(i);
    }
    offset += label.length;
  }

  buffer[offset] = 0;
  offset += 1;
  view.setUint16(offset, recordType);
  offset += 2;
  view.setUint16(offset, 1); // IN class
  return buffer;
}

function generateRequestId(): number {
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    const arr = new Uint16Array(1);
    crypto.getRandomValues(arr);
    return arr[0];
  }
  return Math.floor(Math.random() * 0xffff);
}

function normalizeDomain(domain: string): string {
  const trimmed = domain.trim();
  if (!trimmed) {
    throw new Error("域名不能为空。");
  }
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname.replace(/\.$/, "");
  } catch {
    return trimmed.replace(/\.$/, "");
  }
}

function recordTypeToNumber(recordType: string): number {
  const upper = recordType.toUpperCase();
  if (upper === "A") return 1;
  if (upper === "AAAA") return 28;
  if (upper === "HTTPS") return HTTPS_RECORD_TYPE;
  const numeric = Number(recordType);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  throw new Error(`不支持的 DNS 记录类型: ${recordType}`);
}

function isTextContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes("text/") || normalized.includes("application/text") || normalized.includes("text/plain");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function extractIpsFromAnswer(json: unknown): string[] {
  const answers = extractAnswerArray(json);
  if (!answers) return [];
  const seen = new Set<string>();
  for (const answer of answers) {
    if (typeof answer !== "object" || !answer) continue;
    const data = (answer as Record<string, unknown>).data;
    if (typeof data === "string" && isIpAddress(data)) {
      seen.add(data);
    }
  }
  return Array.from(seen);
}

function extractHttpsRecord(json: unknown): string | null {
  const answers = extractAnswerArray(json);
  if (!answers) return null;
  for (const answer of answers) {
    if (typeof answer !== "object" || !answer) continue;
    const record = answer as Record<string, unknown>;
    const type = typeof record.type === "number" ? record.type : parseInt(String(record.type), 10);
    if (type === HTTPS_RECORD_TYPE) {
      const data = record.data;
      if (typeof data === "string" && data.includes("ech=")) {
        return data;
      }
    }
  }
  return null;
}

function extractAnswerArray(json: unknown): unknown[] | null {
  if (!json || typeof json !== "object") return null;
  const answer = (json as Record<string, unknown>).Answer;
  if (!Array.isArray(answer)) return null;
  return answer;
}

function isIpAddress(value: string): boolean {
  return IP_V4_REGEX.test(value) || IP_V6_REGEX.test(value);
}

function setsAreEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function createTimeoutSignal(timeout: number): AbortSignal {
  if (typeof AbortSignal !== "undefined" && typeof (AbortSignal as { timeout?: (ms: number) => AbortSignal }).timeout === "function") {
    return (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout(timeout);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeout);
  return controller.signal;
}

function normalizeErrorMessage(error: unknown): string {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return "未知错误";
  }
}

function serializeError(error: unknown): unknown {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }
  if (typeof error === "string") return { message: error };
  return error;
}

function mergeHeaders(existing: HeadersInit | undefined, defaults: Record<string, string>): HeadersInit {
  const headers = new Headers(existing ?? {});
  for (const [key, value] of Object.entries(defaults)) {
    if (!headers.has(key)) {
      headers.set(key, value);
    }
  }
  return headers;
}

function createJsonResponse(data: unknown, init: ResponseInit = {}): Response {
  const headers = mergeHeaders(init.headers, JSON_HEADERS);
  return withCors(new Response(JSON.stringify(data), { ...init, headers }));
}

function createErrorResponse(message: string, status = 500, error?: unknown): Response {
  const payload = { status: "error", message, error: serializeError(error) };
  return createJsonResponse(payload, { status });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  return new Response(response.body, { ...response, headers });
}

function isJsonContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes("application/dns-json") || normalized.includes("application/json") || normalized.includes("text/json");
}

async function tryParseJsonClone(response: Response): Promise<unknown | null> {
  try {
    const clone = response.clone();
    return await clone.json();
  } catch {
    return null;
  }
}

function createDnsMessageRaw(buffer: ArrayBuffer, contentType: string | null): { format: string; contentType: string | null; base64: string } {
  return {
    format: "dns-message",
    contentType,
    base64: arrayBufferToBase64(buffer),
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return bytesToBase64(bytes);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  if (typeof btoa === "function") {
    return btoa(binary);
  }
  // @ts-ignore Buffer 仅在某些构建环境可用
  return Buffer.from(binary, "binary").toString("base64");
}

function extractIpsFromDnsMessage(buffer: ArrayBuffer): string[] {
  const message = new Uint8Array(buffer);
  if (message.length < 12) return [];
  const view = new DataView(buffer);
  const qdcount = view.getUint16(4);
  const ancount = view.getUint16(6);
  let offset = 12;
  const seen = new Set<string>();

  for (let i = 0; i < qdcount; i += 1) {
    const nameInfo = readDnsName(message, offset);
    offset += nameInfo.length;
    offset += 4; // type + class
  }

  for (let i = 0; i < ancount; i += 1) {
    const nameInfo = readDnsName(message, offset);
    offset += nameInfo.length;

    if (offset + 10 > message.length) break;
    const type = view.getUint16(offset);
    offset += 2;
    offset += 2; // class
    offset += 4; // ttl
    const rdlength = view.getUint16(offset);
    offset += 2;
    if (offset + rdlength > message.length) break;

    if (type === 1 && rdlength === 4) {
      const ip = formatIpv4(message.subarray(offset, offset + 4));
      seen.add(ip);
    } else if (type === 28 && rdlength === 16) {
      const ip = formatIpv6(message.subarray(offset, offset + 16));
      seen.add(ip);
    }

    offset += rdlength;
  }

  return Array.from(seen);
}

function findHttpsRecordInDnsMessage(buffer: ArrayBuffer): { found: boolean; record?: string; error?: string } {
  const message = new Uint8Array(buffer);
  if (message.length < 12) {
    return { found: false, error: "DNS 报文过短。" };
  }
  const view = new DataView(buffer);
  const qdcount = view.getUint16(4);
  const ancount = view.getUint16(6);
  let offset = 12;
  let fallbackRecord: string | undefined;

  try {
    for (let i = 0; i < qdcount; i += 1) {
      const nameInfo = readDnsName(message, offset);
      offset += nameInfo.length;
      offset += 4;
    }

    for (let i = 0; i < ancount; i += 1) {
      const nameInfo = readDnsName(message, offset);
      offset += nameInfo.length;

      if (offset + 10 > message.length) break;
      const type = view.getUint16(offset);
      offset += 2;
      offset += 2; // class
      offset += 4; // ttl
      const rdlength = view.getUint16(offset);
      offset += 2;
      if (offset + rdlength > message.length) break;

      if (type === HTTPS_RECORD_TYPE) {
        const { hasEch, description } = parseHttpsSvcbRecord(message, offset, rdlength);
        if (hasEch) {
          return { found: true, record: description };
        }
        if (!fallbackRecord && description) {
          fallbackRecord = description;
        }
      }

      offset += rdlength;
    }
  } catch (error) {
    return { found: false, error: normalizeErrorMessage(error) };
  }

  return { found: false, record: fallbackRecord };
}

function parseHttpsSvcbRecord(message: Uint8Array, offset: number, rdlength: number): { hasEch: boolean; description: string } {
  if (offset + rdlength > message.length) {
    return { hasEch: false, description: "" };
  }

  const view = new DataView(message.buffer, message.byteOffset + offset, rdlength);
  let cursor = 0;
  if (rdlength < 4) {
    return { hasEch: false, description: "" };
  }

  const priority = view.getUint16(cursor);
  cursor += 2;

  const nameInfo = readDnsName(message, offset + cursor);
  cursor += nameInfo.length;
  const targetName = nameInfo.name || ".";

  const params: string[] = [];
  let hasEch = false;
  let echBase64: string | undefined;

  while (cursor < rdlength) {
    if (cursor + 4 > rdlength) {
      break;
    }
    const key = view.getUint16(cursor);
    cursor += 2;
    const valueLength = view.getUint16(cursor);
    cursor += 2;
    if (cursor + valueLength > rdlength) {
      break;
    }
    const valueBytes = message.subarray(offset + cursor, offset + cursor + valueLength);
    if (key === 5) {
      hasEch = true;
      echBase64 = bytesToBase64(valueBytes);
    }
    params.push(`key${key}(${valueLength}B)`);
    cursor += valueLength;
  }

  let description = `priority=${priority} target=${targetName}`;
  if (params.length > 0) {
    description += ` params=[${params.join(", ")}]`;
  }
  if (hasEch) {
    description += echBase64 ? ` echconfig(base64)=${echBase64}` : " echconfig";
  }

  return { hasEch, description };
}

function readDnsName(message: Uint8Array, offset: number): { name: string; length: number } {
  const labels: string[] = [];
  let length = 0;
  let jumped = false;
  let currentOffset = offset;
  let safety = 0;

  while (true) {
    if (safety > message.length) {
      throw new Error("DNS 名称解析超出安全限制");
    }
    safety += 1;

    if (currentOffset >= message.length) {
      throw new Error("DNS 名称超出报文范围");
    }

    const len = message[currentOffset];

    if ((len & 0xc0) === 0xc0) {
      const nextByte = message[currentOffset + 1];
      if (nextByte === undefined) {
        throw new Error("DNS 名称指针截断");
      }
      const pointer = ((len & 0x3f) << 8) | nextByte;
      if (!jumped) {
        length += 2;
      }
      if (pointer >= message.length) {
        throw new Error("DNS 名称指针越界");
      }
      currentOffset = pointer;
      jumped = true;
      continue;
    }

    if (len === 0) {
      if (!jumped) {
        length += 1;
      }
      break;
    }

    if (len > 63) {
      throw new Error("DNS 标签长度非法");
    }

    const start = currentOffset + 1;
    const end = start + len;
    if (end > message.length) {
      throw new Error("DNS 标签超出报文范围");
    }
    labels.push(readLabel(message, start, len));
    currentOffset = end;
    if (!jumped) {
      length += 1 + len;
    }
  }

  return { name: labels.join("."), length };
}

function readLabel(message: Uint8Array, start: number, length: number): string {
  let label = "";
  for (let i = 0; i < length; i += 1) {
    label += String.fromCharCode(message[start + i]);
  }
  return label;
}

function formatIpv4(bytes: Uint8Array): string {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

function formatIpv6(bytes: Uint8Array): string {
  const segments: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    const segment = (bytes[i * 2] << 8) | bytes[i * 2 + 1];
    segments.push(segment.toString(16));
  }
  return segments.join(":");
}

const IP_V4_REGEX = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IP_V6_REGEX = /^(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}$/;

const HTML_PAGE = /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DoH &amp; ECH 检测工具</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f4f7;
      --fg: #1f2933;
      --card-bg: #ffffffdd;
      --primary: #2563eb;
      --success: #059669;
      --error: #dc2626;
      --muted: #6b7280;
    }
    body {
      font-family: "Inter", "PingFang SC", "Microsoft YaHei", sans-serif;
      margin: 0;
      min-height: 100vh;
      background: linear-gradient(135deg, var(--bg), #e0e7ff);
      color: var(--fg);
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 24px;
    }
    main {
      width: min(960px, 100%);
      display: grid;
      gap: 24px;
    }
    header {
      text-align: center;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 2rem;
      margin-bottom: 8px;
    }
    p {
      margin: 0;
      color: var(--muted);
    }
    .card {
      padding: 24px;
      border-radius: 16px;
      background: var(--card-bg);
      box-shadow: 0 20px 45px -20px rgba(37, 99, 235, 0.45);
      backdrop-filter: blur(12px);
    }
    .card h2 {
      margin-top: 0;
      font-size: 1.5rem;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    label {
      font-weight: 600;
    }
    input[type="text"] {
      padding: 12px 16px;
      border-radius: 12px;
      border: 1px solid rgba(37, 99, 235, 0.3);
      font-size: 1rem;
      outline: none;
      transition: border-color 0.2s ease;
    }
    input[type="text"]:focus {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.2);
    }
    button {
      appearance: none;
      border: none;
      padding: 12px 18px;
      border-radius: 12px;
      font-size: 1rem;
      font-weight: 600;
      background: var(--primary);
      color: #fff;
      cursor: pointer;
      transition: transform 0.15s ease, box-shadow 0.15s ease;
    }
    button:hover {
      transform: translateY(-1px);
      box-shadow: 0 12px 24px -12px rgba(37, 99, 235, 0.6);
    }
    button[disabled] {
      background: var(--muted);
      cursor: progress;
      box-shadow: none;
    }
    .result {
      border-left: 4px solid transparent;
      padding-left: 12px;
      margin-top: 12px;
      display: none;
    }
    .result.active { display: block; }
    .result.success { border-color: var(--success); }
    .result.failure { border-color: var(--error); }
    .result.partial { border-color: var(--primary); }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.95rem;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .badge.success { color: var(--success); }
    .badge.failure { color: var(--error); }
    .badge.partial { color: var(--primary); }
    .details {
      margin-top: 12px;
    }
    .support-info {
      margin-top: 8px;
      font-size: 0.95rem;
      color: var(--muted);
    }
    details summary {
      cursor: pointer;
      font-weight: 600;
    }
    pre {
      background: rgba(15, 23, 42, 0.85);
      color: #f8fafc;
      padding: 16px;
      border-radius: 12px;
      overflow-x: auto;
    }
    @media (max-width: 720px) {
      body { padding: 16px; }
      main { gap: 16px; }
      .card { padding: 20px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>DoH &amp; ECH 检测工具</h1>
    <p>快速验证自定义 DoH 服务的有效性，并检查目标域名是否启用 ECH。</p>
  </header>
  <main>
    <section class="card" id="doh-card">
      <h2>DoH 有效性检测器</h2>
      <form id="doh-form">
        <label for="doh-url">DoH 服务 URL</label>
        <input id="doh-url" name="doh-url" type="text" placeholder="例如：https://dns.adguard-dns.com/dns-query" required />
        <button type="submit">开始检测</button>
      </form>
      <div class="result" id="doh-result"></div>
    </section>

    <section class="card" id="ech-card">
      <h2>ECH 支持检测器</h2>
      <form id="ech-form">
        <label for="ech-domain">域名</label>
        <input id="ech-domain" name="ech-domain" type="text" placeholder="例如：www.cloudflare.com" required />
        <button type="submit">开始检测</button>
      </form>
      <div class="result" id="ech-result"></div>
    </section>
  </main>
  <script>
    const API_PATH = '/api/check';

    const dohForm = document.getElementById('doh-form');
    const dohResultNode = document.getElementById('doh-result');
    const echForm = document.getElementById('ech-form');
    const echResultNode = document.getElementById('ech-result');

    dohForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await handleSubmit(dohForm, dohResultNode, {
        mode: 'doh',
        target: dohForm['doh-url'].value.trim(),
      });
    });

    echForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      await handleSubmit(echForm, echResultNode, {
        mode: 'ech',
        target: echForm['ech-domain'].value.trim(),
      });
    });

    async function handleSubmit(form, resultNode, payload) {
      const submitButton = form.querySelector('button[type="submit"]');
      const originalText = submitButton.textContent;
      submitButton.disabled = true;
      submitButton.textContent = '检测中…';
      resultNode.className = 'result';
      resultNode.innerHTML = '';

      try {
        const response = await fetch(API_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await response.json();
        renderResult(resultNode, response.ok, data, payload.mode);
      } catch (error) {
        renderError(resultNode, error);
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalText;
      }
    }

    function renderResult(node, ok, data, mode) {
      node.classList.add('active');
      const badge = document.createElement('div');
      badge.classList.add('badge');

      if (!ok || data.status === 'error') {
        badge.classList.add('failure');
        badge.textContent = '✖ 检测失败';
        node.appendChild(badge);
        const message = document.createElement('p');
        message.textContent = data.message || '请求失败，请稍后重试。';
        node.appendChild(message);
        appendDetails(node, data);
        node.classList.add('failure');
        return;
      }

      if (mode === 'doh') {
        const status = data.status;
        if (status === 'success') {
          badge.classList.add('success');
          badge.textContent = '✔ 校验通过';
          node.classList.add('success');
        } else if (status === 'partial_match') {
          badge.classList.add('partial');
          badge.textContent = '△ 部分匹配';
          node.classList.add('partial');
        } else {
          badge.classList.add('failure');
          badge.textContent = '✖ 结果不一致';
          node.classList.add('failure');
        }
        node.appendChild(badge);
        const message = document.createElement('p');
        message.textContent = data.message;
        node.appendChild(message);
        appendDohSupportInfo(node, data.details);
        appendDetails(node, data);
      } else {
        if (data.ech_enabled) {
          badge.classList.add('success');
          badge.textContent = '✔ ECH 已启用';
          node.classList.add('success');
        } else {
          badge.classList.add('failure');
          badge.textContent = '✖ 未检测到 ECH';
          node.classList.add('failure');
        }
        node.appendChild(badge);
        const message = document.createElement('p');
        message.textContent = data.message;
        node.appendChild(message);
        appendDetails(node, data);
      }
    }

    function renderError(node, error) {
      node.classList.add('active', 'failure');
      const badge = document.createElement('div');
      badge.classList.add('badge', 'failure');
      badge.textContent = '✖ 请求异常';
      node.appendChild(badge);
      const message = document.createElement('p');
      message.textContent = error?.message || String(error);
      node.appendChild(message);
    }

    function appendDetails(node, data) {
      const details = document.createElement('details');
      details.classList.add('details');
      const summary = document.createElement('summary');
      summary.textContent = '查看详细数据';
      details.appendChild(summary);
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(data, null, 2);
      details.appendChild(pre);
      node.appendChild(details);
    }

  function appendDohSupportInfo(node, details) {
    if (!details || !details.target) return;
    const target = details.target;
    const attemptedSet = new Set(target.attempted_formats || []);
    const attemptedText = Array.from(attemptedSet).map(formatModeLabel).join('、');
    const contentType = target.content_type || target.raw?.contentType || null;

    const info = document.createElement('p');
    info.classList.add('support-info');

    let html = '<strong>请求格式支持：</strong>';

    if (target.ok && target.response_format && target.response_format !== 'unknown' && target.response_format !== 'text') {
      const supportedLabel = formatModeLabel(target.response_format);
      const extras = Array.from(attemptedSet).filter((fmt) => fmt !== target.response_format);
      html += supportedLabel;
      if (contentType) {
        html += '（Content-Type: ' + contentType + '）';
      }
      if (extras.length > 0) {
        html += '；同时尝试：' + extras.map(formatModeLabel).join('、');
      }
    } else if (target.response_format === 'text') {
      html += '服务器返回文本响应';
      if (contentType) {
        html += '（Content-Type: ' + contentType + '）';
      }
      if (attemptedText) {
        html += '；尝试：' + attemptedText;
      }
    } else if (attemptedText) {
      html += '未检测到可用格式；尝试：' + attemptedText;
    } else {
      html += '未检测到可用格式';
    }

    info.innerHTML = html;
    node.appendChild(info);
  }

  function formatModeLabel(mode) {
    switch (mode) {
      case 'json':
        return 'JSON 查询 (name/type)';
      case 'wire':
        return 'DNS Message (dns=)';
      case 'text':
        return '文本响应';
      case 'unknown':
        return '未知';
      default:
        return mode;
    }
  }
  </script>
</body>
</html>`;
