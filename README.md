# Cloudflare DoH & ECH 检测工具

基于 Cloudflare Worker 的在线检测工具，可快速验证自定义 DoH (DNS-over-HTTPS) 服务的有效性，并判断指定域名是否启用了 ECH (Encrypted Client Hello)。Worker 同时托管前端单页应用，可直接通过 Cloudflare 平台一键部署。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/dong-dong6/DohEchCheckPages)

## 功能亮点

- **双模式检测**：并行请求目标 DoH、Cloudflare DoH、Google DoH，对比 `example.com` (可配置) 的解析结果，输出状态码、延迟、解析 IP 等关键数据。
- **ECH 识别**：查询 HTTPS(type 65) 记录，识别响应中是否包含 `ech=` 字段，判断域名是否启用 ECH。
- **内嵌前端**：无需额外托管，Worker 直接返回响应式 UI，支持高亮状态与详情折叠。
- **标准化 API**：统一 `POST /api/check` 接口，配置了 CORS，便于二次集成或脚本调用。

## 快速开始

- Node.js 18+，已安装 `npm`
- Cloudflare 账号，并安装最新 `wrangler` CLI

```bash
npm install
npm run dev          # 本地调试
npm run check        # Dry-run 检查部署配置
```

本项目无需额外构建步骤，`wrangler` 会自动编译 TypeScript 并内联静态页面。

## 一键部署与上线

- **Deploy to Workers 按钮**：点击顶部「Deploy to Cloudflare Workers」按钮，按提示授权后，Cloudflare 将自动克隆 `https://github.com/dong-dong6/DohEchCheckPages` 并创建 Worker 项目。
- **Wrangler 手动部署**：
  ```bash
  npm run deploy
  ```
  命令会读取 `wrangler.toml` 并部署到当前账号的默认子域。若需绑定自定义域或路由，请在 `wrangler.toml` 中增补 `routes` 或 `zone_id`。
- **Cloudflare Dashboard / Pages 集成**：
  1. 将仓库同步至个人 Git 平台（GitHub/GitLab/Bitbucket）。
  2. Cloudflare Dashboard → Workers & Pages → Create → **Pages** → **Connect to Git**。
  3. 配置：
     - `Production branch`: 主分支
     - `Framework preset`: `None`
     - `Build command`: `npm install && npx wrangler deploy --config wrangler.toml --dry-run`
     - `Build output directory`: 留空
  4. 如需自定义环境变量，请在「Environment variables」面板中添加（见下节）。

> 若通过 Dashboard 直接创建 Worker，可选择「部署现有仓库」，Cloudflare 会自动识别入口文件 `src/worker.ts`。

## 配置与环境变量

`wrangler.toml` 的 `[vars]` 段定义了可选变量：

- `DEFAULT_TEST_DOMAIN`：DoH 检测时默认查询的域名，默认 `example.com`。
- `REQUEST_TIMEOUT_MS`：DoH/ECH 查询请求的超时时间，默认 `5000` 毫秒。

可在 Cloudflare Dashboard → Workers → Settings → Variables & Secrets 中覆盖这些值。

## API 速览

- **接口**：`POST /api/check`
- **请求体**：
  ```json
  {
    "mode": "doh" | "ech",
    "target": "..."
  }
  ```
- **参数说明**：
  - `mode = "doh"`：`target` 为目标 DoH 服务基准 URL，例如 `https://dns.adguard-dns.com/dns-query`
  - `mode = "ech"`：`target` 为待检测域名，例如 `www.cloudflare.com`

更详细的响应示例可参考 `src/worker.ts` 中的实现或前端页面的「查看详细数据」面板。

## 目录结构

```
.
├── package.json          # 项目依赖与常用脚本
├── tsconfig.json         # TypeScript 编译配置
├── wrangler.toml         # Cloudflare Worker 部署配置
└── src
    └── worker.ts         # Worker 逻辑及内联前端页面
```

## 进阶与扩展建议

- 新增更多权威 DoH 服务用于结果对比（如 Quad9、OpenDNS）
- 支持自定义测试域名、记录类型及 POST/RFC8484 DoH 请求
- 引入日志或 Trace ID，方便定位跨区域异常
- 将后端 API 与前端拆分，便于大型平台集成

## 许可

本项目采用 [MIT License](./LICENSE) 进行开源，欢迎自由使用与二次分发。
