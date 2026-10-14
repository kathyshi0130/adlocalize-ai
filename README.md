# AdLocalize AI · 真实 API 增量版

此项目尽量保留原来的 `adlocalize_ai.html` 页面布局、工作流步骤和 CSS 类/ID。真实模式通过 Node.js 后端代理请求模型，模拟模式保留原有定时模拟逻辑并可在 API 失败时自动接管。

## 项目结构

```text
adlocalize_project/
├── frontend/
│   └── index.html          # 原单文件前端的增量修改版
├── backend/
│   ├── server.js           # Express 后端代理：POST /api/analyze
│   ├── package.json
│   └── .env.example
└── render.yaml             # 可选 Render Blueprint 配置模板
```

## 1. 本地运行

需要 Node.js 20 或更新版本。

### 后端

```bash
cd backend
npm install
cp .env.example .env
```

编辑 `backend/.env`，填入你自己的模型 API Key：

```dotenv
OPENAI_API_KEY=your_real_key_here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o
CORS_ORIGINS=http://localhost:8080,http://127.0.0.1:8080
APP_ACCESS_PASSWORD=
PORT=3000
```

然后启动：

```bash
npm start
```

访问 `http://localhost:3000/health`。预期返回类似：`{"status":"ok","modelConfigured":true,...}`。

### 前端

新开一个终端，在项目根目录运行：

```bash
cd frontend
python -m http.server 8080
```

然后打开 `http://localhost:8080`。**不要用 `file:///...` 测真实模式**，因为 `file://` 的 Origin 是 `null`，不建议为它放宽 CORS。直接双击 HTML 可继续使用模拟模式。

前端 `index.html` 顶部的 `CLIENT_CONFIG` 负责后端地址：

```js
const CLIENT_CONFIG = {
  API_BASE_URL: "http://localhost:3000",
  REQUEST_TIMEOUT_MS: 65000,
  MAX_IMAGE_EDGE: 1600,
  IMAGE_JPEG_QUALITY: 0.82
};
```

切换右上方的“运行模式”为“真实 API”，输入文案、上传图片并进入“文化适配检测”步骤，即会调用后端。真实模式会将文案、目标市场、平台和压缩图片/视频首个抽帧发送给你配置的模型服务。图片会在浏览器压缩；视频只提取一帧，不会上传完整视频。

## 2. API 契约

### `POST /api/analyze`

请求 JSON：

```json
{
  "text": "原始中文广告文案",
  "market": "印尼",
  "targetLanguage": "印尼语",
  "platform": "TikTok",
  "tone": "活泼有趣",
  "fileName": "creative.png",
  "fileType": "图片",
  "imageDataUrl": "data:image/jpeg;base64,..."
}
```

图片可选，传入时为 `data:image/jpeg;base64,...`、PNG 或 WebP 等 Data URL。响应严格整理为以下结构：

```json
{
  "cultural": { "risks": [{ "element": "猪元素", "market": "印尼", "reason": "需结合语境判断", "suggestion": "替换建议" }], "score": 75 },
  "translation": { "source": "原始文案", "targetLanguage": "印尼语", "translatedText": "标题：...\n正文：...\nCTA：...", "tone": "活泼有趣" },
  "compliance": { "status": "需人工复核", "issues": [{ "rule": "TikTok 政策", "text": "命中片段", "severity": "高", "suggestion": "修订建议" }] },
  "abVariants": [{ "version": "A", "text": "版本 A", "angle": "探索导向" }, { "version": "B", "text": "版本 B", "angle": "奖励导向" }],
  "tokenUsage": { "input": 1200, "output": 800, "total": 2000 }
}
```

以上字段值只是契约示例，不代表 API 会始终返回这些具体内容。Token Usage 以服务商实际返回为准。

## 3. Render（后端）+ Vercel（前端）公网部署

### A. 推送代码到 GitHub

1. 创建一个私有或公开 GitHub 仓库。
2. 上传整个项目，确保目录为 `frontend/`、`backend/` 和 `render.yaml`。
3. 确认 `backend/.env` 没有提交；它只在本地使用，并且已由 `.gitignore` 忽略或应保持在 Git 外。

建议在仓库根目录新增 `.gitignore`：

```gitignore
node_modules/
.env
.DS_Store
```

### B. 部署后端到 Render

1. 登录 Render，选择 **New → Web Service**，连接刚才的 GitHub 仓库。
2. 如果 Render 支持仓库 Blueprint，也可选择 `render.yaml` 建立 Blueprint；否则按以下字段手动填写：
   - Runtime：Node
   - Root Directory：`backend`
   - Build Command：`npm install`
   - Start Command：`npm start`
   - Health Check Path：`/health`
   - 测试时可选 Free 实例；正式商用需评估稳定性与配额。
3. 在 Render 服务的 **Environment** 中设置：
   - `OPENAI_API_KEY`：你的模型密钥（只填在 Render，不填 HTML/GitHub）
   - `OPENAI_BASE_URL`：OpenAI 默认 `https://api.openai.com/v1`
   - `OPENAI_MODEL`：例如 `gpt-4o`
   - `CORS_ORIGINS`：先填本地测试源；部署完 Vercel 后再加上 `https://你的前端项目.vercel.app`
   - `APP_ACCESS_PASSWORD`：可选的共享访问密码；不用密码时留空
   - `RATE_LIMIT_MAX`：例如 `20`，默认每 IP 每 15 分钟最多 20 次分析
4. 部署成功后，记下 Render 服务 URL，例如 `https://adlocalize-ai-api.onrender.com`。
5. 打开 `https://你的-render-url/health`，确认返回 JSON 且 `modelConfigured: true`。

### C. 配置并部署前端到 Vercel

1. 在 `frontend/index.html` 中将：

   ```js
   API_BASE_URL: "http://localhost:3000"
   ```

   改成 Render URL，例如：

   ```js
   API_BASE_URL: "https://adlocalize-ai-api.onrender.com"
   ```

   这个 URL 是公开的 API 地址，不是密钥。将该修改提交到 GitHub。

2. 在 Vercel 选择 **Add New → Project**，导入同一个 GitHub 仓库。
3. 在项目设置里将 **Root Directory** 设为 `frontend`。
4. Framework Preset 选 **Other**，Build Command 留空，Output Directory 设为 `.`（或保持默认能输出 `index.html` 的配置）。
5. 点击 Deploy，得到 `https://你的项目.vercel.app`。
6. 回到 Render → Environment，把 `CORS_ORIGINS` 更新成逗号分隔的来源，例如：

   ```text
   https://你的项目.vercel.app,http://localhost:8080,http://127.0.0.1:8080
   ```

   如果有 Vercel Preview URL，需要把实际要允许测试的 Preview 域名也明确加进去；不建议使用 `*`。
7. 重新部署/重启 Render 服务，再从 Vercel 网址切换到“真实 API”验证。

### D. 端到端验收

1. 打开前端网址，检查第 1 步上传图片和填写文案。
2. 选择目标市场、语言、平台和语气。
3. 切到真实 API 模式，进入“文化适配检测”并点击运行。
4. 右侧日志应展示真实返回的 Token 用量；文化风险、翻译、合规检查与 A/B 页面应呈现后端响应。
5. 如果后端失联或超时，前端会写入错误日志并自动回退到模拟模式。
6. 试着用不在 `CORS_ORIGINS` 中的域名请求，预期被拒绝。

## 4. API Key 与公开访问安全

- `OPENAI_API_KEY` 只保存在 Render 的 Environment Variables 中。不要放在 `CLIENT_CONFIG`、HTML、Vercel 前端变量、浏览器 localStorage、Git 或截图里。
- 真实模式会将用户素材发给模型服务。上线前要准备隐私告知，说明处理目的、服务商和保留策略，并确认你有权上传广告主/客户素材。
- 公网开放后，任何访问者都可能消耗你账户里的模型额度。共享密码 + IP 限流是基础保护，不等于强用户认证。
- `express-rate-limit` 默认内存计数，单实例演示够用；多实例或商业服务请改为 Redis/托管限流，并增加用户级额度、登录认证、账单监控、请求审计、验证码/防机器人和预算熔断。
- Render Free Web Service 可能在空闲时休眠，第一次请求会较慢；真实商用请评估付费实例。供应商价格和免费额度可能变化，应以部署时平台控制台为准。

## 5. 换成 Dify / Coze 工作流

最稳妥的方式是保持前端契约不变，只替换 `backend/server.js` 中的 `callOpenAICompatibleModel()`：

### Dify

- 在 Dify 创建并发布 Workflow，输入变量可设为 `text`、`market`、`targetLanguage`、`platform`、`tone` 和图片文件/URL。
- 后端用 `fetch` 调用 Dify Workflow API（常见为 `POST {DIFY_BASE_URL}/v1/workflows/run`），请求头 `Authorization: Bearer ${DIFY_API_KEY}`，请求体包含 `inputs`、`response_mode: "blocking"` 和 `user`。
- 从响应 `data.outputs` 取工作流输出，解析其中 JSON 字符串，再送入 `normalizeResult()`。
- `DIFY_API_KEY` 必须只配置在 Render 环境变量里。图片输入需要按 Dify 文件输入规则使用上传文件 ID 或可访问 URL，不要直接假定 Base64 Data URL 可被每个 Dify 节点接收。

### Coze

- 在 Coze 搭建 Workflow/Bot，使用工作流 API 或 Bot API，取决于你创建的应用类型与当前开放平台版本。
- 在后端增加 `callCozeWorkflow(input)`，将文本、目标市场等映射到 Coze 的输入参数；图片按该 API 指定的文件/URL方式上传或传递。
- 将 Coze 输出映射成 `{ cultural, translation, compliance, abVariants, tokenUsage }`，再复用前端现有渲染层。
- 将 `COZE_API_TOKEN`、Bot/Workflow ID 等放入 Render 环境变量。不要从 HTML 直接请求 Coze，否则 Token 会暴露。

接入任何编排平台时，建议让工作流最终输出一个 JSON 对象，并在后端做字段校验与归一化；这样 UI 无需随着供应商切换而重写。

## 6. 将来要上线商业版时建议补强

1. 用正式登录（OIDC/企业 SSO）代替共享密码。
2. 把限流升级为按用户、组织、IP 多维限制，并使用 Redis 等共享存储。
3. 增加每用户 Token/成本预算、单张图片体积限制和上传频率限制。
4. 给模型输出加 JSON Schema 校验与敏感信息过滤；本项目已做基础字段归一化，但仍需安全测试。
5. 文化/法律审核作为风险提示，不要把 LLM 单独作为最终发布批准依据。
