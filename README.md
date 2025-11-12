# DoH & ECH Cloudflare Worker

基于 Cloudflare Workers 的在线检测工具，为任意 DoH 服务与目标域名提供快速验证。

## 功能概览

- **DoH 有效性检测**：并行从目标 DoH、Cloudflare DoH 与 Google DoH 获取 `example.com` 的解析结果，对比 IP 集合与响应状态。
- **ECH 支持检测**：查询目标域名的 `HTTPS`（type 65）记录，识别是否包含 `ech=` 字段。
- **单页前端界面**：Worker 直接返回内联的 HTML/CSS/JS，展示检测结果与原始 JSON 详情。

## 本地开发

```bash
npm install
npm run dev
```

> `npm run dev` 会使用 Wrangler 的远程预览（`wrangler dev --remote`），无需自行配置本地 DoH 服务。

## API 说明

- **端点**：`POST /api/check`
- **请求体**

```json
{
  "mode": "doh" | "ech",
  "target": "string"
}
```

- **响应示例（DoH）**

```json
{
  "mode": "doh",
  "status": "success",
  "message": "目标 DoH 服务返回的解析结果与 Cloudflare 和 Google 完全一致。",
  "details": {
    "target": {
      "ok": true,
      "status": 200,
      "latencyMs": 120,
      "ips": ["93.184.216.34"],
      "raw": {}
    },
    "cloudflare": { "..." : "..." },
    "google": { "..." : "..." }
  }
}
```

- **响应示例（ECH）**

```json
{
  "mode": "ech",
  "ech_enabled": true,
  "message": "检测到 HTTPS 记录中包含 ECH 配置。",
  "providers": {
    "cloudflare": {
      "ok": true,
      "echRecords": ["1 . alpn=\"h2\" ... ech=..."],
      "raw": {}
    },
    "google": { "..." : "..." }
  }
}
```

## 通过 Git 一键部署到 Cloudflare Workers

1. **Fork 或克隆本仓库**，并在主分支包含以下文件：
   - `wrangler.toml`：定义 Worker 名称、入口文件与 `compatibility_date`。
   - `package.json` / `package-lock.json`：包含 `wrangler`、`typescript` 依赖，以及 `deploy` 脚本（已预置）。
   - `src/index.ts`：Worker 入口（模块语法）。
2. **在 Cloudflare 控制台**：依次选择 `Workers & Pages` → `Create application` → `Workers` → `Connect to Git`。
3. **选择仓库与分支**（例如 `main`），构建配置保持默认：
   - Framework preset: `None`
   - Build command: `npm run deploy -- --minify`
   - Build output directory: 留空（Wrangler 负责发布）
4. 首次部署后，可在仪表盘查看 **Production** 与 **Preview** 环境。任何推送到目标分支的提交都会触发自动构建与部署。

> 若需要使用自定义的 Worker 名称，请在 `wrangler.toml` 中修改 `name` 字段，并确保在 Cloudflare 账号下唯一。

## 额外说明

- 内置了 `OPTIONS` 处理与允许的 CORS 头，方便外部系统接入。
- 所有远端 DoH 请求都通过 `Promise.allSettled` 并发执行，即使某个权威服务失败也能返回完整状态。
- 默认测试域名为 `example.com`，如需自定义，可在 `src/index.ts` 中调整 `TEST_DOMAIN`。

祝使用顺利 🎉
