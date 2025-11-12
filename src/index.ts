const CF_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const GOOGLE_DOH_ENDPOINT = "https://dns.google/resolve";
const TEST_DOMAIN = "example.com";

type CheckMode = "doh" | "ech";

interface ApiRequest {
  mode: CheckMode;
  target: string;
}

interface DohResult {
  ok: boolean;
  status: number | null;
  statusText?: string;
  latencyMs?: number;
  ips: string[];
  raw?: unknown;
  error?: string;
}

interface EchResult {
  ok: boolean;
  status: number | null;
  statusText?: string;
  latencyMs?: number;
  records: string[];
  echRecords: string[];
  raw?: unknown;
  error?: string;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return handleOptions();
    }

    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      return new Response(renderHtml(), {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/api/check") {
      if (request.method !== "POST") {
        return methodNotAllowed();
      }

      return handleApi(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleApi(request: Request): Promise<Response> {
  let body: ApiRequest;
  try {
    body = (await request.json()) as ApiRequest;
  } catch {
    return jsonResponse(
      {
        error: "请求体必须为合法的 JSON。",
      },
      { status: 400 },
    );
  }

  const { mode, target } = body ?? {};

  if (mode !== "doh" && mode !== "ech") {
    return jsonResponse(
      {
        error: "mode 字段必须为 \"doh\" 或 \"ech\"。",
      },
      { status: 400 },
    );
  }

  if (typeof target !== "string" || !target.trim()) {
    return jsonResponse(
      {
        error: "target 字段不能为空字符串。",
      },
      { status: 400 },
    );
  }

  if (mode === "doh") {
    return jsonResponse(await checkDoh(target.trim()));
  }

  return jsonResponse(await checkEch(target.trim()));
}

async function checkDoh(targetEndpoint: string) {
  const providers = [
    { key: "target", endpoint: targetEndpoint },
    { key: "cloudflare", endpoint: CF_DOH_ENDPOINT },
    { key: "google", endpoint: GOOGLE_DOH_ENDPOINT },
  ] as const;

  const settled = await Promise.allSettled(
    providers.map((provider) => queryDoh(provider.endpoint, TEST_DOMAIN, "A")),
  );

  const details: Record<(typeof providers)[number]["key"], DohResult> = {
    target: createEmptyDohResult(),
    cloudflare: createEmptyDohResult(),
    google: createEmptyDohResult(),
  };

  settled.forEach((result, index) => {
    const key = providers[index].key;
    if (result.status === "fulfilled") {
      details[key] = result.value;
    } else {
      details[key] = {
        ok: false,
        status: null,
        ips: [],
        error: describeError(result.reason),
      };
    }
  });

  const targetData = details.target;
  const cfData = details.cloudflare;
  const googleData = details.google;

  const targetSet = new Set(targetData.ips);
  const cfSet = new Set(cfData.ips);
  const googleSet = new Set(googleData.ips);

  const matchesCf = targetData.ok && cfData.ok && setsEqual(targetSet, cfSet);
  const matchesGoogle = targetData.ok && googleData.ok && setsEqual(targetSet, googleSet);

  let status: "success" | "failure" | "partial_match";
  let message: string;

  if (!targetData.ok) {
    status = "failure";
    message = "目标 DoH 服务未成功响应测试查询。";
  } else if (matchesCf && matchesGoogle) {
    status = "success";
    message = "目标 DoH 服务返回的解析结果与 Cloudflare 和 Google 完全一致。";
  } else if (matchesCf || matchesGoogle) {
    status = "partial_match";
    message = "目标 DoH 服务的解析结果与部分权威服务一致，请检查潜在差异。";
  } else {
    status = "failure";
    message = "目标 DoH 服务的解析结果与 Cloudflare 和 Google 均不一致。";
  }

  return {
    mode: "doh" as const,
    status,
    message,
    details,
  };
}

async function checkEch(domain: string) {
  const providers = [
    { key: "cloudflare", endpoint: CF_DOH_ENDPOINT },
    { key: "google", endpoint: GOOGLE_DOH_ENDPOINT },
  ] as const;

  const settled = await Promise.allSettled(
    providers.map((provider) => queryHttpsRecord(provider.endpoint, domain)),
  );

  const providerResults: Record<(typeof providers)[number]["key"], EchResult> = {
    cloudflare: createEmptyEchResult(),
    google: createEmptyEchResult(),
  };

  settled.forEach((result, index) => {
    const key = providers[index].key;
    if (result.status === "fulfilled") {
      providerResults[key] = result.value;
    } else {
      providerResults[key] = {
        ok: false,
        status: null,
        records: [],
        echRecords: [],
        error: describeError(result.reason),
      };
    }
  });

  const echEnabled = Object.values(providerResults).some((provider) => provider.echRecords.length > 0);

  const message = echEnabled
    ? "检测到 HTTPS 记录中包含 ECH 配置。"
    : "未检测到包含 ECH 配置的 HTTPS 记录。";

  return {
    mode: "ech" as const,
    ech_enabled: echEnabled,
    message,
    providers: providerResults,
  };
}

async function queryDoh(endpoint: string, name: string, type: string): Promise<DohResult> {
  const start = Date.now();
  try {
    const targetUrl = buildQueryUrl(endpoint, name, type);
    const response = await fetch(targetUrl.toString(), {
      headers: {
        accept: "application/dns-json",
      },
    });
    const latencyMs = Date.now() - start;

    let body: DnsJsonResponse | null = null;
    try {
      body = (await response.json()) as DnsJsonResponse;
    } catch (error) {
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        latencyMs,
        ips: [],
        error: "响应不是有效的 DNS JSON 格式。",
      };
    }

    const answers = Array.isArray(body?.Answer) ? body!.Answer : [];
    const ips = answers
      .filter((answer) => answer && Number(answer.type) === 1 && typeof answer.data === "string")
      .map((answer) => answer.data);

    return {
      ok: response.ok && ips.length > 0,
      status: response.status,
      statusText: response.statusText,
      latencyMs,
      ips,
      raw: body,
      error: response.ok ? undefined : response.statusText || "请求失败",
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      ips: [],
      error: describeError(error),
    };
  }
}

async function queryHttpsRecord(endpoint: string, name: string): Promise<EchResult> {
  const start = Date.now();
  try {
    const targetUrl = buildQueryUrl(endpoint, name, "HTTPS");
    const response = await fetch(targetUrl.toString(), {
      headers: {
        accept: "application/dns-json",
      },
    });
    const latencyMs = Date.now() - start;

    let body: DnsJsonResponse | null = null;
    try {
      body = (await response.json()) as DnsJsonResponse;
    } catch {
      return {
        ok: false,
        status: response.status,
        statusText: response.statusText,
        latencyMs,
        records: [],
        echRecords: [],
        error: "响应不是有效的 DNS JSON 格式。",
      };
    }

    const answers = Array.isArray(body?.Answer) ? body!.Answer : [];
    const httpsRecords = answers
      .filter((answer) => answer && Number(answer.type) === 65 && typeof answer.data === "string")
      .map((answer) => answer.data);

    const echRecords = httpsRecords.filter((record) => record.includes("ech="));

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      latencyMs,
      records: httpsRecords,
      echRecords,
      raw: body,
      error: response.ok ? undefined : response.statusText || "请求失败",
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      records: [],
      echRecords: [],
      error: describeError(error),
    };
  }
}

function buildQueryUrl(endpoint: string, name: string, type: string) {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`无法解析 DoH 端点：${endpoint}`);
  }

  url.searchParams.set("name", name);
  url.searchParams.set("type", type);
  return url;
}

function setsEqual<T>(a: Set<T>, b: Set<T>) {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

function createEmptyDohResult(): DohResult {
  return {
    ok: false,
    status: null,
    ips: [],
  };
}

function createEmptyEchResult(): EchResult {
  return {
    ok: false,
    status: null,
    records: [],
    echRecords: [],
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status: init.status ?? 200,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

function methodNotAllowed(): Response {
  return new Response("Method Not Allowed", {
    status: 405,
    headers: corsHeaders(),
  });
}

function renderHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>DoH & ECH 检测工具</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
        background-color: #10131a;
        color: #e8ebf2;
      }

      body {
        margin: 0;
        padding: 2.5rem 1.5rem 4rem;
        display: flex;
        flex-direction: column;
        gap: 2.5rem;
        max-width: 960px;
        margin-inline: auto;
      }

      header {
        text-align: center;
      }

      h1 {
        margin: 0 0 0.75rem;
        font-size: clamp(2rem, 4vw, 2.75rem);
      }

      p.description {
        margin: 0 auto;
        max-width: 640px;
        line-height: 1.6;
        color: #b4bdd1;
      }

      section {
        background: rgba(21, 27, 38, 0.85);
        border: 1px solid rgba(79, 103, 147, 0.35);
        border-radius: 18px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.3);
        padding: clamp(1.5rem, 3vw, 2rem);
        backdrop-filter: blur(12px);
      }

      section h2 {
        margin-top: 0;
        font-size: 1.5rem;
        letter-spacing: 0.01em;
      }

      form {
        display: grid;
        gap: 1rem;
      }

      label {
        font-weight: 600;
        font-size: 0.95rem;
        color: #d5ddef;
      }

      input[type="text"] {
        padding: 0.85rem 1rem;
        border-radius: 12px;
        border: 1px solid rgba(79, 103, 147, 0.45);
        background: rgba(6, 10, 21, 0.55);
        color: inherit;
        transition: border-color 0.2s ease, box-shadow 0.2s ease;
      }

      input[type="text"]:focus {
        outline: none;
        border-color: #3a89ff;
        box-shadow: 0 0 0 3px rgba(58, 137, 255, 0.25);
      }

      button {
        justify-self: start;
        padding: 0.75rem 1.5rem;
        border-radius: 12px;
        border: none;
        background: linear-gradient(135deg, #3a89ff, #8f6bff);
        color: white;
        font-weight: 600;
        letter-spacing: 0.01em;
        cursor: pointer;
        transition: transform 0.2s ease, box-shadow 0.2s ease;
      }

      button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
      }

      button:not(:disabled):hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 24px rgba(58, 137, 255, 0.32);
      }

      .result {
        border-radius: 12px;
        padding: 1rem 1.25rem;
        background: rgba(9, 13, 24, 0.6);
        border: 1px solid transparent;
        line-height: 1.6;
      }

      .result.success {
        border-color: rgba(58, 181, 65, 0.5);
        background: rgba(24, 55, 32, 0.6);
      }

      .result.failure {
        border-color: rgba(227, 74, 100, 0.55);
        background: rgba(60, 22, 33, 0.6);
      }

      .result.partial {
        border-color: rgba(255, 180, 51, 0.55);
        background: rgba(58, 42, 12, 0.6);
      }

      .result span {
        font-weight: 600;
        font-size: 1.05rem;
      }

      details {
        margin-top: 1rem;
        border-radius: 10px;
        background: rgba(7, 11, 21, 0.7);
        border: 1px solid rgba(79, 103, 147, 0.35);
        padding: 0.75rem 1rem;
      }

      summary {
        cursor: pointer;
        font-weight: 600;
      }

      pre {
        margin-top: 0.75rem;
        white-space: pre-wrap;
        word-break: break-word;
      }

      footer {
        text-align: center;
        font-size: 0.85rem;
        color: #77809b;
      }

      a {
        color: #7fa6ff;
      }
    </style>
  </head>
  <body>
    <header>
      <h1>DoH &amp; ECH 检测工具</h1>
      <p class="description">
        输入目标 DoH 服务或域名，快速检查响应与 ECH 支持情况。所有检测均在 Cloudflare Worker 边缘网络完成。
      </p>
    </header>

    <section>
      <h2>DoH 有效性检测器</h2>
      <form id="doh-form" data-mode="doh">
        <label for="doh-input">DoH 服务 URL</label>
        <input
          id="doh-input"
          name="doh"
          type="text"
          placeholder="例如：https://dns.adguard-dns.com/dns-query"
          required
        />
        <button type="submit">开始检测</button>
      </form>
      <div id="doh-result" class="result" hidden></div>
      <details id="doh-details" hidden>
        <summary>查看详情</summary>
        <pre></pre>
      </details>
    </section>

    <section>
      <h2>ECH 支持检测器</h2>
      <form id="ech-form" data-mode="ech">
        <label for="ech-input">域名</label>
        <input
          id="ech-input"
          name="ech"
          type="text"
          placeholder="例如：www.cloudflare.com"
          required
        />
        <button type="submit">开始检测</button>
      </form>
      <div id="ech-result" class="result" hidden></div>
      <details id="ech-details" hidden>
        <summary>查看详情</summary>
        <pre></pre>
      </details>
    </section>

    <footer>
      由 Cloudflare Workers 提供支持 · 检测逻辑基于 DoH JSON 响应规范
    </footer>

    <script>
      const forms = document.querySelectorAll("form[data-mode]");

      forms.forEach((form) => {
        form.addEventListener("submit", async (event) => {
          event.preventDefault();

          const mode = form.dataset.mode;
          const input = form.querySelector("input");
          const button = form.querySelector("button[type=submit]");
          const resultEl = document.getElementById(\`\${mode}-result\`);
          const detailsEl = document.getElementById(\`\${mode}-details\`);
          const detailsPre = detailsEl?.querySelector("pre");

          if (!input || !button || !resultEl || !detailsEl || !detailsPre) {
            console.error("缺少必要的 DOM 元素。");
            return;
          }

          const target = input.value.trim();
          if (!target) {
            showResult(resultEl, "failure", "请输入有效的目标。");
            return;
          }

          button.disabled = true;
          const originalText = button.textContent;
          button.textContent = "检测中…";

          showResult(resultEl, null, "正在检测，请稍候…");
          detailsEl.hidden = true;
          detailsPre.textContent = "";

          try {
            const response = await fetch("/api/check", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ mode, target }),
            });

            const data = await response.json();

            if (!response.ok) {
              showResult(resultEl, "failure", data?.error ?? "请求失败。");
            } else if (mode === "doh") {
              const status = data.status ?? "failure";
              const type =
                status === "success" ? "success" : status === "partial_match" ? "partial" : "failure";
              showResult(resultEl, type, data.message ?? "检测完成。");
            } else {
              const enabled = Boolean(data.ech_enabled);
              showResult(
                resultEl,
                enabled ? "success" : "failure",
                data.message ?? (enabled ? "ECH 已启用。" : "未发现 ECH 配置。"),
              );
            }

            detailsEl.hidden = false;
            detailsPre.textContent = JSON.stringify(data, null, 2);
          } catch (error) {
            console.error(error);
            showResult(resultEl, "failure", "请求过程中出现错误，请稍后重试。");
          } finally {
            button.disabled = false;
            button.textContent = originalText;
          }
        });
      });

      function showResult(element, status, message) {
        element.hidden = false;
        element.textContent = message;
        element.classList.remove("success", "failure", "partial");
        if (status) {
          element.classList.add(status);
        }
      }
    </script>
  </body>
</html>`;
}

interface DnsJsonResponse {
  Status?: number;
  TC?: boolean;
  RD?: boolean;
  RA?: boolean;
  AD?: boolean;
  CD?: boolean;
  Question?: Array<{ name: string; type: number }>;
  Answer?: Array<{ name: string; type: number; TTL: number; data: string }>;
  Authority?: Array<unknown>;
  Additional?: Array<unknown>;
}
