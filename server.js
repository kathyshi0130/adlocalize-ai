import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS || 55_000);
const MODEL_RETRIES = 1; // 除首次请求外，最多再重试一次瞬时网络/服务端错误。
const MAX_IMAGE_DATA_CHARS = 8_500_000; // 约 6 MB 的 base64 图片数据，压缩建议仍在前端完成。

// Render 等反向代理环境需正确读取真实客户端 IP，以让限流按 IP 生效。
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));

const defaultOrigins = [
  "http://localhost:8080",
  "http://127.0.0.1:8080",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || defaultOrigins.join(","))
    .split(",").map((origin) => origin.trim()).filter(Boolean)
);

// 不放行 file:// 的 Origin: null。请通过 localhost 或已部署 HTTPS 站点访问真实模式。
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked origin: ${origin}`));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "X-App-Password"],
  maxAge: 86400
}));
app.use(express.json({ limit: "12mb" }));

const analyzeLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  limit: Number(process.env.RATE_LIMIT_MAX || 20),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "请求过于频繁，请稍后再试。", code: "RATE_LIMITED" }
});

function safeString(value, max = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function isSafeEqualText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
function requireOptionalPassword(req, res, next) {
  const expected = process.env.APP_ACCESS_PASSWORD;
  if (!expected) return next();
  const provided = req.get("X-App-Password") || "";
  if (!provided) {
    return res.status(401).json({ error: "此实例需要访问密码。", code: "APP_PASSWORD_REQUIRED" });
  }
  if (!isSafeEqualText(provided, expected)) {
    return res.status(401).json({ error: "访问密码不正确。", code: "APP_PASSWORD_REQUIRED" });
  }
  return next();
}

app.get("/", (_req, res) => res.json({
  name: "AdLocalize AI API",
  status: "ok",
  endpoints: ["GET /health", "POST /api/analyze"]
}));
app.get("/health", (_req, res) => res.json({
  status: "ok",
  modelConfigured: Boolean(process.env.OPENAI_API_KEY),
  timestamp: new Date().toISOString()
}));

const SYSTEM_PROMPT = `你是出海广告素材本地化与风险筛查助手。根据用户提供的原始文案、目标市场、语言、投放平台、品牌语气，以及可选的图片，生成本地化文案并识别潜在文化/政策风险。

必须遵守：
1. 只输出一个合法 JSON 对象，不要 Markdown 代码围栏或 JSON 之外的解释。
2. 不要假装你具备法律裁定权，也不要把不确定文化推断说成绝对事实。将不确定点写成待复核建议。
3. 只根据实际收到的图片与文本判断。未提供图片时，不得虚构视觉元素；如果没有可确认的文化风险，risks 返回空数组。
4. 合规审核是辅助筛查，不得承诺素材必然通过平台审核或符合所有当地法律。凡缺少落地页、受众定向、数据收集流程等上下文，要提示人工复核。
5. 翻译要自然，保留原始产品事实，不夸大功效，不添加无事实依据的折扣、奖项、结果承诺或性能指标。
6. A/B 变体需要有不同诉求角度，文案仍然符合产品事实。输出 2–3 个变体。
7. tokenUsage 由服务器覆盖，请在输出中先填 0 即可。

输出结构必须严格遵守：
{
 "cultural":{"risks":[{"element":"元素名称","market":"目标市场","reason":"原因与不确定性","suggestion":"具体替代建议"}],"score":0},
 "translation":{"source":"原始中文文案","targetLanguage":"目标语言","translatedText":"标题、正文与 CTA 的完整本地化文案，可用换行分隔","tone":"指定语气"},
 "compliance":{"status":"通过 或 需人工复核","issues":[{"rule":"规则/政策名称","text":"命中的原文或相关描述","severity":"高/中/低","suggestion":"修订建议"}]},
 "abVariants":[{"version":"A","text":"变体文案","angle":"创意角度"},{"version":"B","text":"变体文案","angle":"创意角度"}],
 "tokenUsage":{"input":0,"output":0,"total":0}
}

评分含义：cultural.score 为 0–100 的风险关注评分，分数越高代表风险越需要关注；它不是素材质量分。若存在不确定或上下文缺失的合规问题，status 应为“需人工复核”。`;

function buildUserPrompt(input) {
  return `请分析以下出海广告素材，并按指定 JSON 格式输出结果。
目标市场：${input.market}
目标语言：${input.targetLanguage}
投放平台：${input.platform}
品牌语气：${input.tone}
文件名称：${input.fileName || "未上传文件"}
输入媒体类型：${input.fileType || "仅文案"}
原始中文文案：\n${input.text || "（未提供文案；请基于图像进行可行范围内的分析）"}

规则检查时至少考虑：
- 目标市场相关文化敏感元素、宗教符号、手势、颜色/数字象征等（有证据时才列风险）；
- 目标语言的本地化表达与自然度；
- ${input.platform} 常见的误导性或夸大声明风险；
- 若涉及个人数据采集、追踪或受众画像，提醒核查 GDPR/适用隐私法规、告知与同意机制；
- 对缺少完整落地页、证据材料或受众信息的事项，明确提示需人工复核。

translation.translatedText 请输出一个可直接由广告团队编辑的完整版本，使用“标题：...\n正文：...\nCTA：...”结构；不要编造尚未提供的产品属性。`;
}

function extractJsonContent(content) {
  if (typeof content !== "string") throw new Error("模型未返回文本内容。请确认所选模型支持多模态 Chat Completions 格式。");
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); }
  catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("模型返回内容不是合法 JSON。请重试或更换模型。");
  }
}

function normalizeSeverity(value) {
  const text = String(value || "中").toLowerCase();
  if (text.includes("高") || text.includes("high") || text.includes("critical")) return "高";
  if (text.includes("低") || text.includes("low")) return "低";
  return "中";
}
function normalizeResult(raw, input, usage = {}) {
  const cultural = raw?.cultural || {};
  const translation = raw?.translation || {};
  const compliance = raw?.compliance || {};
  const riskList = Array.isArray(cultural.risks) ? cultural.risks : [];
  const issues = Array.isArray(compliance.issues) ? compliance.issues : [];
  let variants = Array.isArray(raw?.abVariants) ? raw.abVariants : [];
  variants = variants.slice(0, 3).map((v, index) => ({
    version: String(v?.version || String.fromCharCode(65 + index)).slice(0, 8),
    text: safeString(v?.text, 4000),
    angle: safeString(v?.angle, 200)
  })).filter(v => v.text);
  while (variants.length < 2) {
    const index = variants.length;
    variants.push({
      version: String.fromCharCode(65 + index),
      text: safeString(translation.translatedText || input.text, 4000),
      angle: index === 0 ? "核心卖点" : "语气与 CTA 优化"
    });
  }
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? raw?.tokenUsage?.input ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? raw?.tokenUsage?.output ?? 0) || 0;
  const totalTokens = Number(usage.total_tokens ?? usage.totalTokens ?? raw?.tokenUsage?.total ?? (inputTokens + outputTokens)) || 0;
  const reportedStatus = safeString(compliance.status, 40);
  const status = reportedStatus === "通过" && issues.length === 0 ? "通过" : "需人工复核";
  const score = Math.max(0, Math.min(100, Number(cultural.score ?? 0) || 0));

  return {
    cultural: {
      risks: riskList.slice(0, 12).map((risk) => ({
        element: safeString(risk?.element || risk?.title, 200) || "待确认元素",
        market: safeString(risk?.market, 100) || input.market,
        reason: safeString(risk?.reason || risk?.description, 1200) || "需结合当地语境进一步确认。",
        suggestion: safeString(risk?.suggestion, 1200) || "请当地审核人员确认合适的替代方案。"
      })),
      score
    },
    translation: {
      source: input.text,
      targetLanguage: safeString(translation.targetLanguage, 100) || input.targetLanguage,
      translatedText: safeString(translation.translatedText, 8000) || "模型没有生成可用文案，请重试。",
      tone: safeString(translation.tone, 100) || input.tone
    },
    compliance: {
      status,
      issues: issues.slice(0, 20).map((issue) => ({
        rule: safeString(issue?.rule, 200) || "合规辅助检查",
        text: safeString(issue?.text, 800) || "未明确定位原文片段",
        severity: normalizeSeverity(issue?.severity),
        suggestion: safeString(issue?.suggestion, 1200) || "建议人工复核后修订。"
      }))
    },
    abVariants: variants,
    tokenUsage: { input: inputTokens, output: outputTokens, total: totalTokens }
  };
}

function validateInput(body) {
  const input = {
    text: safeString(body?.text, 20_000),
    market: safeString(body?.market, 100) || "印尼",
    targetLanguage: safeString(body?.targetLanguage, 100) || "印尼语",
    platform: safeString(body?.platform, 100) || "TikTok",
    tone: safeString(body?.tone, 100) || "活泼有趣",
    fileName: safeString(body?.fileName, 300),
    fileType: safeString(body?.fileType, 50),
    imageDataUrl: typeof body?.imageDataUrl === "string" ? body.imageDataUrl : null
  };
  if (!input.text && !input.imageDataUrl) {
    const error = new Error("请至少上传一张图片或输入广告文案。"); error.status = 400; throw error;
  }
  if (input.imageDataUrl) {
    if (input.imageDataUrl.length > MAX_IMAGE_DATA_CHARS) {
      const error = new Error("图片数据过大。请使用较小图片，或在前端降低压缩质量/分辨率。"); error.status = 413; throw error;
    }
    if (!/^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(input.imageDataUrl)) {
      const error = new Error("imageDataUrl 格式无效。请传入 data:image/jpeg;base64,... 等图片 Data URL。"); error.status = 400; throw error;
    }
  }
  return input;
}

async function callOpenAICompatibleModel(input) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error("后端未配置 OPENAI_API_KEY 环境变量。"); error.status = 503; throw error;
  }
  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const endpoint = `${baseUrl}/chat/completions`;
  const userContent = [{ type: "text", text: buildUserPrompt(input) }];
  if (input.imageDataUrl) {
    userContent.push({ type: "image_url", image_url: { url: input.imageDataUrl, detail: "high" } });
  }
  const requestBody = {
    model,
    temperature: 0.35,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ]
  };

  let lastError;
  for (let attempt = 0; attempt <= MODEL_RETRIES; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
      const responseBody = await response.json().catch(() => ({}));
      if (!response.ok) {
        const providerMessage = responseBody?.error?.message || responseBody?.message || `模型服务返回 HTTP ${response.status}`;
        const error = new Error(providerMessage);
        error.status = response.status;
        // 不重试 API Key、参数、额度等确定性错误；仅重试限流/暂时性服务错误。
        if (![408, 429, 500, 502, 503, 504].includes(response.status) || attempt >= MODEL_RETRIES) throw error;
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
        continue;
      }
      const content = responseBody?.choices?.[0]?.message?.content;
      const parsed = extractJsonContent(content);
      return { parsed, usage: responseBody.usage || {}, model };
    } catch (error) {
      lastError = error;
      if (error?.name === "AbortError") {
        lastError = new Error(`模型请求超过 ${MODEL_TIMEOUT_MS} ms，已超时。`);
      }
      const retryable = error?.name === "TypeError" || /fetch failed|network|timeout|超时/i.test(error?.message || "");
      if (!retryable || attempt >= MODEL_RETRIES) throw lastError;
      await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError || new Error("模型调用失败，请重试。");
}

app.post("/api/analyze", analyzeLimiter, requireOptionalPassword, async (req, res, next) => {
  const startedAt = Date.now();
  try {
    const input = validateInput(req.body || {});
    const { parsed, usage, model } = await callOpenAICompatibleModel(input);
    const result = normalizeResult(parsed, input, usage);
    // 日志只输出状态/用量，不打印用户文案、图片、Authorization 或 API Key。
    console.info(JSON.stringify({
      event: "analyze_success", model, elapsedMs: Date.now() - startedAt,
      tokenUsage: result.tokenUsage, hasImage: Boolean(input.imageDataUrl), market: input.market, platform: input.platform
    }));
    res.json(result);
  } catch (error) {
    console.error(JSON.stringify({ event: "analyze_error", status: error.status || 500, message: error.message, elapsedMs: Date.now() - startedAt }));
    next(error);
  }
});

// 统一错误处理：不把内部调用栈、密钥或供应商完整响应返回给浏览器。
app.use((error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error?.message?.startsWith("CORS blocked origin:")) {
    return res.status(403).json({ error: "此网页来源未被后端 CORS 白名单允许。", code: "CORS_ORIGIN_BLOCKED" });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ error: "请求体过大。请压缩图片后重试。", code: "BODY_TOO_LARGE" });
  }
  const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
  const safeMessage = status === 500 ? "服务端处理失败，请稍后重试或查看后端日志。" : error.message;
  return res.status(status).json({ error: safeMessage, code: status === 503 ? "MODEL_NOT_CONFIGURED" : "REQUEST_FAILED" });
});

app.listen(PORT, "0.0.0.0", () => {
  console.info(`AdLocalize AI API listening on port ${PORT}`);
  if (!process.env.OPENAI_API_KEY) console.warn("OPENAI_API_KEY is not configured; /health will report modelConfigured=false.");
});
