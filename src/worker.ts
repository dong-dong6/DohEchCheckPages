interface Env {
  DEFAULT_TEST_DOMAIN?: string;
  REQUEST_TIMEOUT_MS?: string;
}

type DohStatus = "success" | "failure" | "partial_match";

type Mode = "doh" | "ech";

type ProviderKey = "target" | "cloudflare" | "google";

type DohResponseFormat = "json" | "wire" | "text" | "unknown";

type DohBaseResult = {
  status: number | null;
  ok: boolean;
  ips: string[];
  latency_ms: number | null;
  response_format?: DohResponseFormat;
  content_type?: string | null;
  raw?: unknown;
  error?: string;
};

interface DohProviderModeResult extends DohBaseResult {
  mode: DohRequestMode;
}

interface DohProviderResult extends DohBaseResult {
  attempted_formats: DohRequestMode[];
  mode_results?: DohProviderModeResult[];
}

interface DohApiResponse {
  status: DohStatus;
  message: string;
  details: Record<ProviderKey, DohProviderResult>;
  comparison: {
    matches_cloudflare: boolean;
    matches_google: boolean;
  };
  ech_comparison?: DohEchComparison;
}

type EchBaseResult = {
  found: boolean;
  record?: string;
  status: number | null;
  latency_ms: number | null;
  response_format?: DohResponseFormat;
  content_type?: string | null;
  raw?: unknown;
  error?: string;
};

interface EchProviderModeResult extends EchBaseResult {
  mode: DohRequestMode;
}

interface EchProviderResult extends EchBaseResult {
  attempted_formats: DohRequestMode[];
  mode_results?: EchProviderModeResult[];
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
      const testDomain = env.DEFAULT_TEST_DOMAIN?.trim() || "linux.do";

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
  const echComparison = await runDohEchComparison(providers, testDomain, timeout);

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

  if (echComparison) {
    if (echComparison.consistent === false) {
      message += " 检测到目标 DoH 返回的 ECH 配置与权威解析不一致，可能存在篡改。";
    } else if (echComparison.consistent === true) {
      message += " 同时确认 ECH 配置与权威解析一致。";
    }
  }

  return {
    status,
    message,
    details,
    comparison: {
      matches_cloudflare: matchesCloudflare,
      matches_google: matchesGoogle,
    },
    ech_comparison: echComparison ?? undefined,
  };
}

type DohEchComparison = {
  target: EchProviderResult;
  cloudflare: EchProviderResult;
  google: EchProviderResult;
  matches_cloudflare: boolean | null;
  matches_google: boolean | null;
  consistent: boolean | null;
  notes: string[];
};

async function runDohEchComparison(providers: DohProviderConfig[], domain: string, timeout: number): Promise<DohEchComparison | null> {
  const echProviders = providers.filter((provider) => provider.key === "target" || provider.key === "cloudflare" || provider.key === "google");
  const fetchPromises = echProviders.map(({ key, endpoint }) =>
    fetchHttpsRecord(endpoint, domain, timeout).then((result) => ({ key, result }))
  );

  const settled = await Promise.allSettled(fetchPromises);
  const echResults = Object.fromEntries(
    settled.map((entry, index) => {
      const key = echProviders[index].key;
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
  ) as Record<ProviderKey, EchProviderResult>;

  const targetResult = echResults.target;
  const cloudflareResult = echResults.cloudflare;
  const googleResult = echResults.google;

  if (!targetResult && !cloudflareResult && !googleResult) {
    return null;
  }

  const targetEch = extractEchConfigString(targetResult);
  const cloudflareEch = extractEchConfigString(cloudflareResult);
  const googleEch = extractEchConfigString(googleResult);

  const notes: string[] = [];
  const matchesCloudflare = computeEchMatch(targetEch, cloudflareEch, notes, "Cloudflare");
  const matchesGoogle = computeEchMatch(targetEch, googleEch, notes, "Google");

  let consistent: boolean | null = null;
  if (matchesCloudflare !== null && matchesGoogle !== null) {
    consistent = matchesCloudflare && matchesGoogle;
  } else if (matchesCloudflare !== null || matchesGoogle !== null) {
    consistent = matchesCloudflare === false || matchesGoogle === false ? false : null;
  }

  return {
    target: targetResult,
    cloudflare: cloudflareResult,
    google: googleResult,
    matches_cloudflare: matchesCloudflare,
    matches_google: matchesGoogle,
    consistent,
    notes,
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
  const modeResults: DohProviderModeResult[] = [];

  for (const mode of ["json", "wire"] as const) {
    const result = await performDohRequest(endpoint, name, recordType, timeout, mode);
    modeResults.push(result);
  }

  const successful = modeResults.find((item) => item.ok);
  let summary: DohProviderResult;

  if (successful) {
    summary = summarizeDohModeResult(successful, modeResults);
  } else {
    summary = combineDohFailures(modeResults);
  }

  summary.attempted_formats = modeResults.map((item) => item.mode);
  summary.mode_results = modeResults;
  return summary;
}

async function performDohRequest(endpoint: string, name: string, recordType: string, timeout: number, mode: DohRequestMode): Promise<DohProviderModeResult> {
  let url: URL;
  try {
    url = mode === "json" ? buildDohJsonUrl(endpoint, name, recordType) : buildDohWireUrl(endpoint, name, recordType);
  } catch (error) {
    return {
      mode,
      status: null,
      ok: false,
      ips: [],
      latency_ms: null,
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
          mode,
          status,
          ok,
          ips,
          latency_ms,
          response_format: "json",
          content_type: contentType,
          raw: json,
          error: ok ? undefined : "未在响应中找到有效的 A 记录。",
        };
      } catch (error) {
        return {
          mode,
          status,
          ok: false,
          ips: [],
          latency_ms,
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
        mode,
        status,
        ok: false,
        ips: [],
        latency_ms,
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
        mode,
        status,
        ok,
        ips,
        latency_ms,
        response_format: "wire",
        content_type: contentType,
        raw,
        error: ok ? undefined : "未在响应中找到有效的 A/AAAA 记录。",
      };
    } catch (error) {
      return {
        mode,
        status,
        ok: false,
        ips: [],
        latency_ms,
        response_format: "wire",
        content_type: contentType,
        raw,
        error: `解析 DNS 二进制报文失败：${normalizeErrorMessage(error)}`,
      };
    }
  } catch (error) {
    return {
      mode,
      status: null,
      ok: false,
      ips: [],
      latency_ms: null,
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

function summarizeDohModeResult(successful: DohProviderModeResult, attempts: DohProviderModeResult[]): DohProviderResult {
  const { mode, ...rest } = successful;
  return {
    ...rest,
    attempted_formats: attempts.map((item) => item.mode),
    mode_results: attempts,
  };
}

function combineDohFailures(results: DohProviderModeResult[]): DohProviderResult {
  if (results.length === 0) {
    return {
      status: null,
      ok: false,
      ips: [],
      latency_ms: null,
      response_format: "unknown",
      content_type: null,
      raw: undefined,
      error: "DoH 查询失败。",
      attempted_formats: [],
      mode_results: [],
    };
  }

  const last = results[results.length - 1];
  let status = last.status;
  let latency = last.latency_ms;
  let responseFormat = last.response_format;
  let contentType = last.content_type ?? null;
  let raw = last.raw;

  if (status === null) {
    for (const item of [...results].reverse()) {
      if (item.status !== null) {
        status = item.status;
        break;
      }
    }
  }

  if (latency === null) {
    for (const item of [...results].reverse()) {
      if (item.latency_ms !== null) {
        latency = item.latency_ms;
        break;
      }
    }
  }

  if (!responseFormat || responseFormat === "unknown") {
    responseFormat = results.map((item) => item.response_format).find((format) => format && format !== "unknown") ?? "unknown";
  }

  if (!contentType) {
    contentType = results.map((item) => item.content_type).find((type) => Boolean(type)) ?? null;
  }

  const errors = results.map((item) => item.error).filter(Boolean) as string[];

  return {
    status,
    ok: false,
    ips: Array.from(new Set(results.flatMap((item) => item.ips))),
    latency_ms: latency,
    response_format: responseFormat,
    content_type: contentType,
    raw,
    error: errors.length > 0 ? errors.join(" | ") : "DoH 查询失败。",
    attempted_formats: results.map((item) => item.mode),
    mode_results: results,
  };
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

function extractEchConfigString(result?: EchProviderResult): string | null {
  if (!result) return null;
  if (!result.found || !result.record) {
    if (typeof result.raw === "string") {
      const parsed = parseEchFromRecordString(result.raw);
      if (parsed) return parsed;
    }
    return null;
  }
  return parseEchFromRecordString(result.record);
}

function parseEchFromRecordString(record: string): string | null {
  if (!record) return null;
  const match = record.match(/ech(?:config\(base64\))?=("[^"]+"|[^\\s]+)/i);
  if (!match) return null;
  let value = match[1];
  if (!value) return null;
  if (value.startsWith("\"") && value.endsWith("\"")) {
    value = value.slice(1, -1);
  }
  return value || null;
}

function computeEchMatch(target: string | null, reference: string | null, notes: string[], label: string): boolean | null {
  if (!target && !reference) {
    notes.push(`${label} 和目标 DoH 均未返回 ECH 配置。`);
    return null;
  }
  if (!target) {
    notes.push(`目标 DoH 未返回 ECH 配置，但 ${label} 返回了配置。`);
    return false;
  }
  if (!reference) {
    notes.push(`${label} 未返回 ECH 配置，无法比对。`);
    return null;
  }
  if (target === reference) {
    notes.push(`目标 DoH 与 ${label} 的 ECH 配置一致。`);
    return true;
  }
  notes.push(`目标 DoH 与 ${label} 的 ECH 配置不一致。`);
  return false;
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
        margin-top: 18px;
        border-radius: 14px;
        border: 1px solid rgba(37, 99, 235, 0.18);
        background: rgba(255, 255, 255, 0.65);
        overflow: hidden;
        transition: box-shadow 0.2s ease;
      }
      .details[open] {
        box-shadow: 0 24px 48px -32px rgba(37, 99, 235, 0.55);
      }
      .details summary {
        margin: 0;
        padding: 14px 18px;
        cursor: pointer;
        font-weight: 600;
        list-style: none;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .details summary::marker {
        display: none;
      }
      .details summary span {
        font-size: 0.9rem;
        color: var(--muted);
      }
      .details[open] summary {
        border-bottom: 1px solid rgba(37, 99, 235, 0.16);
      }
      .details-content {
        padding: 18px;
        display: grid;
        gap: 18px;
      }
      .details-section {
        border-radius: 12px;
        border: 1px solid rgba(37, 99, 235, 0.2);
        padding: 16px;
        background: rgba(255, 255, 255, 0.75);
        box-shadow: 0 18px 40px -32px rgba(37, 99, 235, 0.45);
      }
      .details-section h4 {
        margin: 0 0 10px;
        font-size: 1.05rem;
      }
      .provider-grid {
        display: grid;
        gap: 12px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      }
      .provider-card {
        border: 1px solid rgba(37, 99, 235, 0.24);
        border-radius: 12px;
        padding: 12px 14px;
        background: rgba(255, 255, 255, 0.85);
        display: grid;
        gap: 6px;
      }
      .provider-card.success {
        border-color: rgba(5, 150, 105, 0.5);
      }
      .provider-card.failure {
        border-color: rgba(220, 38, 38, 0.45);
      }
      .provider-card .name {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-weight: 600;
      }
      .provider-card .status {
        font-size: 0.92rem;
      }
      .provider-card .status.success {
        color: var(--success);
      }
      .provider-card .status.failure {
        color: var(--error);
      }
      .provider-card .ips,
      .provider-card .meta,
      .provider-card .note {
        font-size: 0.9rem;
        color: var(--muted);
      }
      .provider-card .highlight {
        font-size: 0.92rem;
        color: var(--fg);
        word-break: break-all;
      }
      .notes-list {
        margin: 0;
        padding-left: 20px;
        color: var(--muted);
        font-size: 0.95rem;
      }
      .notes-list li + li {
        margin-top: 6px;
      }
    .ech-summary {
      margin-top: 18px;
      border-radius: 16px;
      border: 1px solid rgba(37, 99, 235, 0.2);
      background: rgba(255, 255, 255, 0.78);
      padding: 18px 20px;
      box-shadow: 0 20px 46px -26px rgba(37, 99, 235, 0.45);
      display: grid;
      gap: 14px;
    }
    .ech-summary h3 {
      margin: 0;
      font-size: 1.15rem;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .ech-summary .summary-status {
      font-size: 0.95rem;
      font-weight: 600;
    }
    .ech-summary .summary-status.success {
      color: var(--success);
    }
    .ech-summary .summary-status.failure {
      color: var(--error);
    }
    .ech-summary .summary-status.neutral {
      color: var(--muted);
    }
    .ech-summary .hint {
      font-size: 0.9rem;
      color: var(--muted);
    }
      .detail-status {
        font-weight: 600;
        font-size: 0.95rem;
        margin-bottom: 10px;
      }
      .detail-status.success {
        color: var(--success);
      }
      .detail-status.failure {
        color: var(--error);
      }
      .detail-status.neutral {
        color: var(--muted);
      }
      .mode-cards {
      margin-top: 16px;
      display: grid;
      gap: 12px;
    }
    .mode-card {
      padding: 14px 16px;
      border-radius: 12px;
      border: 1px solid rgba(37, 99, 235, 0.25);
      background: rgba(255, 255, 255, 0.75);
      box-shadow: 0 10px 24px -18px rgba(37, 99, 235, 0.4);
    }
    .mode-card.success {
      border-color: var(--success);
    }
    .mode-card.failure {
      border-color: var(--error);
    }
    .mode-card h3 {
      margin: 0 0 6px;
      font-size: 1.05rem;
    }
    .mode-card p {
      margin: 4px 0;
    }
    .mode-card .meta {
      color: var(--muted);
      font-size: 0.9rem;
    }
    .mode-card .doc-link {
      margin-top: 6px;
      font-size: 0.88rem;
      color: var(--primary);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .mode-card .doc-link::after {
      content: "↗";
      font-size: 0.85rem;
    }
    .mode-card .doc-link:hover {
      text-decoration: underline;
    }
    .raw-json pre {
      background: rgba(15, 23, 42, 0.9);
      color: #f8fafc;
      padding: 16px;
      border-radius: 12px;
      overflow: auto;
      margin: 0;
      max-height: 280px;
      overflow-wrap: anywhere;
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.45;
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
      if (mode === 'doh' && data?.ech_comparison) {
        renderEchComparisonSummary(node, data.ech_comparison);
      }
      appendDetails(node, data, mode);
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
      if (data.ech_comparison) {
        renderEchComparisonSummary(node, data.ech_comparison);
      }
      renderDohModeCards(node, data.details?.target);
      appendDetails(node, data, mode);
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
      appendDetails(node, data, mode);
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

function renderEchComparisonSummary(node, comparison) {
  const section = document.createElement('section');
  section.classList.add('ech-summary');

  const title = document.createElement('h3');
  title.textContent = 'ECH 配置校验结果';
  section.appendChild(title);

  const status = document.createElement('div');
  status.classList.add('summary-status');
  if (comparison.consistent === true) {
    status.classList.add('success');
    status.textContent = '目标 DoH 的 ECH 配置与权威解析完全一致。';
  } else if (comparison.consistent === false) {
    status.classList.add('failure');
    status.textContent = '检测到目标 DoH 的 ECH 配置与权威解析不一致，可能存在篡改风险。';
  } else {
    status.classList.add('neutral');
    status.textContent = '暂无法确认目标 DoH 的 ECH 配置是否与权威解析一致。';
  }
  section.appendChild(status);

  const echState = computeEchState(comparison);
  if (echState.message) {
    const stateLine = document.createElement('div');
    stateLine.classList.add('hint');
    stateLine.textContent = echState.message;
    section.appendChild(stateLine);
  }

  const hint = document.createElement('div');
  hint.classList.add('hint');
  hint.textContent = '展开详细数据可查看各解析器的原始记录。';
  section.appendChild(hint);

  node.appendChild(section);
}

function computeEchState(comparison) {
  const targetHasEch = providerHasEch(comparison.target);
  const cloudflareHasEch = providerHasEch(comparison.cloudflare);
  const googleHasEch = providerHasEch(comparison.google);
  const authorityHasEch = cloudflareHasEch || googleHasEch;

  if (!targetHasEch && !authorityHasEch) {
    return {
      code: 1,
      message: '状态 1：目标 DoH、Cloudflare、Google 均未返回 ECH 配置。',
    };
  }

  if (!targetHasEch && authorityHasEch) {
    return {
      code: 2,
      message: '状态 2：权威解析（Cloudflare/Google）已提供 ECH，但目标 DoH 未返回，请检查自定义服务。',
    };
  }

  if (targetHasEch && cloudflareHasEch && googleHasEch && comparison.consistent === true) {
    return {
      code: 3,
      message: '状态 3：目标 DoH、Cloudflare、Google 均返回 ECH，配置完全一致。',
    };
  }

  if (targetHasEch && authorityHasEch && comparison.consistent === false) {
    return {
      code: 4,
      message: '状态 4：目标 DoH 返回 ECH，但与权威解析不一致，存在被篡改风险。',
    };
  }

  return { code: 0, message: '' };
}

function providerHasEch(provider) {
  if (!provider) return false;
  if (provider.found && provider.record) return true;
  if (typeof provider.record === 'string' && provider.record.toLowerCase().includes('ech')) return true;
  if (typeof provider.raw === 'string' && provider.raw.toLowerCase().includes('ech')) return true;
  return false;
}

      function appendDetails(node, data, mode) {
      const details = document.createElement('details');
      details.classList.add('details');
      const summary = document.createElement('summary');
        summary.innerHTML = '查看详细数据 <span>展开以查看更多字段</span>';
      details.appendChild(summary);
        const content = document.createElement('div');
        content.classList.add('details-content');
        details.appendChild(content);

        buildDetailsSections(data, mode).forEach((section) => content.appendChild(section));
        content.appendChild(buildRawJsonSection(data));
      node.appendChild(details);
    }

      function buildDetailsSections(data, mode) {
        const sections = [];
        if (!data) return sections;
        if (mode === 'doh' && data.details) {
          sections.push(buildDohProvidersSection(data.details));
        }
        if (mode === 'ech' && data.providers) {
          sections.push(buildEchProvidersSection(data.providers));
        }
        if (mode === 'doh' && data.ech_comparison) {
          sections.push(buildEchComparisonSection(data.ech_comparison));
        }
        return sections;
      }

      function buildDohProvidersSection(details) {
        const section = document.createElement('section');
        section.classList.add('details-section');
        const title = document.createElement('h4');
        title.textContent = '解析器结果概览';
        section.appendChild(title);

        const grid = document.createElement('div');
        grid.classList.add('provider-grid');
        Object.entries(details).forEach(([key, provider]) => {
          grid.appendChild(createDohProviderCard(key, provider));
        });
        section.appendChild(grid);
        return section;
      }

      function buildEchProvidersSection(providers) {
        const section = document.createElement('section');
        section.classList.add('details-section');
        const title = document.createElement('h4');
        title.textContent = 'HTTPS 记录详情';
        section.appendChild(title);

        const grid = document.createElement('div');
        grid.classList.add('provider-grid');
        Object.entries(providers).forEach(([key, provider]) => {
          grid.appendChild(createEchProviderCard(key, provider));
        });
        section.appendChild(grid);
        return section;
      }

      function buildEchComparisonSection(comparison) {
        const section = document.createElement('section');
        section.classList.add('details-section');
        const title = document.createElement('h4');
        title.textContent = 'ECH 配置一致性';
        section.appendChild(title);

        const status = document.createElement('div');
        status.classList.add('detail-status');
        if (comparison.consistent === true) {
          status.classList.add('success');
          status.textContent = '目标 DoH 返回的 ECH 配置已与权威解析保持一致。';
        } else if (comparison.consistent === false) {
          status.classList.add('failure');
          status.textContent = '检测到目标 DoH 返回的 ECH 配置与权威解析不一致。';
        } else {
          status.classList.add('neutral');
          status.textContent = '暂无法给出明确的 ECH 一致性结论。';
        }
        section.appendChild(status);

        if (Array.isArray(comparison.notes) && comparison.notes.length > 0) {
          const list = document.createElement('ul');
          list.classList.add('notes-list');
          comparison.notes.forEach((note) => {
            const item = document.createElement('li');
            item.textContent = note;
            list.appendChild(item);
          });
          section.appendChild(list);
        }

        const grid = document.createElement('div');
        grid.classList.add('provider-grid');
        grid.appendChild(createEchProviderCard('target', comparison.target));
        grid.appendChild(createEchProviderCard('cloudflare', comparison.cloudflare));
        grid.appendChild(createEchProviderCard('google', comparison.google));
        section.appendChild(grid);

        return section;
      }

      function buildRawJsonSection(data) {
        const section = document.createElement('section');
        section.classList.add('details-section', 'raw-json');
        const title = document.createElement('h4');
        title.textContent = '原始响应';
        section.appendChild(title);
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(data, null, 2);
        section.appendChild(pre);
        return section;
      }

      function createDohProviderCard(key, provider) {
        const card = document.createElement('div');
        card.classList.add('provider-card');
        const ok = Boolean(provider?.ok);
        card.classList.add(ok ? 'success' : 'failure');

        const header = document.createElement('div');
        header.classList.add('name');
        const name = document.createElement('span');
        name.textContent = formatProviderLabel(key);
        const status = document.createElement('span');
        status.classList.add('status', ok ? 'success' : 'failure');
        status.textContent = ok ? '✔ 已返回有效记录' : '✖ 未能解析';
        header.appendChild(name);
        header.appendChild(status);
        card.appendChild(header);

        if (provider?.ips && provider.ips.length > 0) {
          const ips = document.createElement('div');
          ips.classList.add('ips');
          ips.textContent = 'IP：' + provider.ips.join('、');
          card.appendChild(ips);
        }

        const metaPieces = [];
        if (typeof provider?.latency_ms === 'number') metaPieces.push('耗时 ' + provider.latency_ms + ' ms');
        if (provider?.response_format) metaPieces.push('格式 ' + String(provider.response_format).toUpperCase());
        if (provider?.content_type) metaPieces.push(provider.content_type);
        if (metaPieces.length > 0) {
          const meta = document.createElement('div');
          meta.classList.add('meta');
          meta.textContent = metaPieces.join(' | ');
          card.appendChild(meta);
        }

        if (!ok && provider?.error) {
          const note = document.createElement('div');
          note.classList.add('note');
          note.textContent = provider.error;
          card.appendChild(note);
        }

        return card;
      }

      function createEchProviderCard(key, provider) {
        const card = document.createElement('div');
        card.classList.add('provider-card');
        const hasEch = Boolean(provider && provider.found && provider.record);
        card.classList.add(hasEch ? 'success' : 'failure');

        const header = document.createElement('div');
        header.classList.add('name');
        const name = document.createElement('span');
        name.textContent = formatProviderLabel(key);
        const status = document.createElement('span');
        status.classList.add('status', hasEch ? 'success' : 'failure');
        status.textContent = hasEch ? '✔ 含 ECH 配置' : '✖ 未检测到 ECH';
        header.appendChild(name);
        header.appendChild(status);
        card.appendChild(header);

        if (provider?.record) {
          const record = document.createElement('div');
          record.classList.add('highlight');
          record.textContent = provider.record;
          card.appendChild(record);
        }

        const metaPieces = [];
        if (typeof provider?.latency_ms === 'number') metaPieces.push('耗时 ' + provider.latency_ms + ' ms');
        if (provider?.response_format) metaPieces.push('格式 ' + String(provider.response_format).toUpperCase());
        if (provider?.content_type) metaPieces.push(provider.content_type);
        if (metaPieces.length > 0) {
          const meta = document.createElement('div');
          meta.classList.add('meta');
          meta.textContent = metaPieces.join(' | ');
          card.appendChild(meta);
        }

        if (!hasEch && provider?.error) {
          const note = document.createElement('div');
          note.classList.add('note');
          note.textContent = provider.error;
          card.appendChild(note);
        }

        return card;
      }

  function renderDohModeCards(node, targetDetail) {
    const modes = targetDetail?.mode_results || [];
    if (modes.length === 0) return;

    const container = document.createElement('div');
    container.classList.add('mode-cards');

    modes.forEach((entry) => {
      const card = document.createElement('div');
      card.classList.add('mode-card');
      card.classList.add(entry.ok ? 'success' : 'failure');

      const title = document.createElement('h3');
      title.textContent = formatModeLabel(entry.mode);
      card.appendChild(title);

      const statusLine = document.createElement('p');
      statusLine.textContent = entry.ok
        ? '✔ 请求成功'
        : '✖ ' + (entry.error || '请求失败');
      card.appendChild(statusLine);

      if (entry.ips && entry.ips.length > 0) {
        const ipLine = document.createElement('p');
        ipLine.classList.add('meta');
        ipLine.textContent = '解析 IP：' + entry.ips.join('、');
        card.appendChild(ipLine);
      }

      const metaPieces = [];
      if (typeof entry.latency_ms === 'number') {
        metaPieces.push('耗时 ' + entry.latency_ms + ' ms');
      }
      if (entry.content_type) {
        metaPieces.push('Content-Type: ' + entry.content_type);
      }
      if (metaPieces.length > 0) {
        const meta = document.createElement('p');
        meta.classList.add('meta');
        meta.textContent = metaPieces.join(' | ');
        card.appendChild(meta);
      }

      const docLink = getModeDocLink(entry.mode);
      if (docLink) {
        const link = document.createElement('a');
        link.classList.add('doc-link');
        link.href = docLink.href;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        link.textContent = docLink.label;
        card.appendChild(link);
      }

      container.appendChild(card);
    });

    node.appendChild(container);
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

function getModeDocLink(mode) {
  switch (mode) {
    case 'json':
      return {
        href: 'https://developers.google.com/speed/public-dns/docs/doh/json',
        label: '查看 JSON DoH 权威说明',
      };
    case 'wire':
      return {
        href: 'https://www.rfc-editor.org/rfc/rfc8484',
        label: '查看 RFC 8484 DoH 规范',
      };
    default:
      return null;
  }
}

    function formatProviderLabel(key) {
      switch (key) {
        case 'target':
          return '目标 DoH';
        case 'cloudflare':
          return 'Cloudflare';
        case 'google':
          return 'Google';
        default:
          return key;
      }
    }
  </script>
</body>
</html>`;
