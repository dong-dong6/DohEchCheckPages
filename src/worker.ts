interface Env {
  DEFAULT_TEST_DOMAIN?: string;
  REQUEST_TIMEOUT_MS?: string;
}

type DohStatus = "success" | "failure" | "partial_match";

type Mode = "doh" | "ech";

type ProviderKey = "target" | "cloudflare" | "google";

interface DohProviderResult {
  status: number | null;
  ok: boolean;
  ips: string[];
  latency_ms: number | null;
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
        error: normalizeErrorMessage(entry.reason),
      } satisfies EchProviderResult];
    })
  ) as EchApiResponse["providers"];

  const echEnabled = Object.values(providerResults).some((provider) => provider.found && provider.record?.includes("ech="));

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
  const url = buildDohUrl(endpoint, name, recordType);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: createTimeoutSignal(timeout),
    });
    const latency_ms = Date.now() - started;
    const status = response.status;
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      return {
        status,
        ok: false,
        ips: [],
        latency_ms,
        raw: null,
        error: "响应不是有效的 JSON 数据。",
      };
    }

    const ips = extractIpsFromAnswer(json);
    const ok = response.ok && ips.length > 0;
    return {
      status,
      ok,
      ips,
      latency_ms,
      raw: json,
      error: ok ? undefined : "未在响应中找到有效的 A 记录。",
    };
  } catch (error) {
    return {
      status: null,
      ok: false,
      ips: [],
      latency_ms: null,
      error: normalizeErrorMessage(error),
    };
  }
}

async function fetchHttpsRecord(endpoint: string, domain: string, timeout: number): Promise<EchProviderResult> {
  const url = buildDohUrl(endpoint, domain, String(HTTPS_RECORD_TYPE));
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/dns-json" },
      signal: createTimeoutSignal(timeout),
    });
    const latency_ms = Date.now() - started;
    const status = response.status;
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      return {
        found: false,
        record: undefined,
        status,
        latency_ms,
        error: "响应不是有效的 JSON 数据。",
      };
    }

    const record = extractHttpsRecord(json);
    const found = Boolean(record);

    return {
      found,
      record: record ?? undefined,
      status,
      latency_ms,
      raw: json,
      error: found ? undefined : "未发现包含 ECH 参数的 HTTPS 记录。",
    };
  } catch (error) {
    return {
      found: false,
      record: undefined,
      status: null,
      latency_ms: null,
      error: normalizeErrorMessage(error),
    };
  }
}

function buildDohUrl(endpoint: string, name: string, type: string): string {
  try {
    const url = new URL(endpoint);
    url.searchParams.set("name", name);
    url.searchParams.set("type", type);
    return url.toString();
  } catch (error) {
    throw new Error(`无效的 DoH 端点: ${endpoint}. ${normalizeErrorMessage(error)}`);
  }
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
  </script>
</body>
</html>`;
