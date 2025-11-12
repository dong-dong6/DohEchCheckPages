# Cloudflare DoH & ECH 检测工具

基于 Cloudflare Worker 的在线检测工具，可快速验证自定义 DoH (DNS-over-HTTPS) 服务的有效性，并判断指定域名是否启用了 ECH (Encrypted Client Hello)。后端使用 Cloudflare Worker，同时直接托管前端单页应用，支持在 Cloudflare 仪表盘或使用 Wrangler 一键部署。

## 功能概览

- **DoH 有效性检测**：并行查询目标 DoH、Cloudflare DoH、Google DoH，对比 `example.com` (默认，可配置) 的解析结果，输出状态码、延迟、解析 IP 等详细数据。
- **ECH 支持检测**：向 Cloudflare 与 Google DoH 查询目标域名的 `HTTPS` (type 65) 记录，识别记录中是否包含 `ech=` 字段。
- **自带前端页面**：Worker 直接返回响应式 UI，支持结果高亮与「查看详情」展开原始 JSON，便于工程人员排查。
- **CORS 支持**：统一 API (`/api/check`) 支持跨域，便于后续集成到其它控制台或脚本中。

## 目录结构

```
.
├── package.json          # 项目依赖与常用脚本
├── tsconfig.json         # TypeScript 编译配置
├── wrangler.toml         # Cloudflare Worker 部署配置
└── src
    └── worker.ts         # Worker 逻辑及内联前端页面
```

## 本地开发

1. 安装依赖：
   ```bash
   npm install
   ```
2. 本地调试（Cloudflare 仿真环境）：
   ```bash
   npm run dev
   ```
3. Dry run 部署校验：
   ```bash
   npm run check
   ```

> **注意**：本仓库未使用额外构建资源，`wrangler` 会自动编译 TypeScript 并内联静态页面。

## API 说明

请求路径：`POST /api/check`

请求体：
```json
{
  "mode": "doh" | "ech",
  "target": "..."
}
```

- `mode = "doh"`：`target` 填写 DoH 服务的基准 URL（示例：`https://dns.adguard-dns.com/dns-query`）。
- `mode = "ech"`：`target` 填写需检测的域名（示例：`www.cloudflare.com`）。

返回示例请参考 `src/worker.ts` 及前端页面「查看详情」面板。

## Cloudflare 部署指引

### 1. 通过 Wrangler 部署

```bash
npm run deploy
```

该命令将读取 `wrangler.toml`，并将 Worker 发布到 Cloudflare 账号配置的默认子域。如果需要指定自定义域或路由，可编辑 `wrangler.toml` 中的 `routes` 或 `zone_id` 信息。

### 2. Cloudflare 仪表盘 + Git 一键部署

1. 将本仓库推送至您的 Git 代码托管平台（GitHub/GitLab/Bitbucket）。
2. 打开 Cloudflare Dashboard → Workers & Pages → Create → **Pages** → **Connect to Git**。
3. 选择仓库后，在「Build settings」中设置：
   - **Production branch**：选择主分支。
   - **Framework preset**：选择 `None`。
   - **Build command**：填入 `npm install && npx wrangler deploy --config wrangler.toml --dry-run` （Cloudflare 会在自动部署时跳过真正的部署，仅需保留构建步骤即可，或直接设为空指令）。
   - **Build output directory**：留空，因 Worker 项目无需静态构建输出。
4. 在「Environment variables (advanced)」添加：
   - `DEFAULT_TEST_DOMAIN`（可选）：覆盖默认测试域名。
   - `REQUEST_TIMEOUT_MS`（可选）：重写 DoH 请求超时时间（毫秒）。
5. 提交后，Cloudflare 将自动使用 Wrangler 进行 Worker 构建并发布，整个过程完全兼容官方一键部署流程。

> 若直接在 Worker 控制台创建项目，也可选择「部署现有仓库」，Cloudflare 将读取 `wrangler.toml` 并自动识别入口 `src/worker.ts`。

## 环境变量

项目中使用了两个可选变量（见 `wrangler.toml` 的 `[vars]` 部分）：

- `DEFAULT_TEST_DOMAIN`：DoH 检测时查询的域名，默认 `example.com`。
- `REQUEST_TIMEOUT_MS`：DoH/ECH 查询请求最大等待时间，默认 `5000` 毫秒。

可在 Cloudflare 仪表盘 → Worker → Settings → Variables & Secrets 中覆盖这些值。

## 后续扩展建议

- 增加更多权威 DoH 服务用于对比（Quad9、OpenDNS 等）。
- 允许用户自定义测试域名与记录类型。
- 对目标 DoH 支持基于 POST 的 RFC8484 查询。
- 引入日志/Trace ID 便于分布式排障。

## 许可

根据项目实际需求选择适用的开源协议并更新本节。
