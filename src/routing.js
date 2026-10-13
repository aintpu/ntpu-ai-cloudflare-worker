import { __name } from "./utils.js";
import { MODEL_CANDIDATES, MODEL_NOTES, MODEL_TO_ROUTE, openRouterHeaders, providerModel, JUDGE_ALIAS } from "./models.js";

var JUDGE_SYSTEM_PROMPT = `\u4F60\u662F\u4E00\u500B\u8DEF\u7531\u6C7A\u7B56\u6A21\u578B\uFF0C\u5C08\u9580\u8CA0\u8CAC\u8A55\u4F30\u4F7F\u7528\u8005\u8A0A\u606F\u7684\u4EFB\u52D9\u96E3\u5EA6\uFF0C\u6C7A\u5B9A\u8981\u4EA4\u7D66\u54EA\u500B\u7D1A\u8DDD\u8207\u54EA\u500B\u56DE\u7B54\u6A21\u578B\u8655\u7406\u3002

\u4F60\u7684\u552F\u4E00\u5DE5\u4F5C\u662F\u8F38\u51FA\u8DEF\u7531 JSON\uFF0C\u4E0D\u8981\u56DE\u7B54\u4F7F\u7528\u8005\u7684\u554F\u984C\u3002

\u8A55\u5206\u6A19\u6E96\uFF080\u201310\uFF09\uFF1A
- 0\u20133\uFF1A\u9592\u804A\u3001\u554F\u5019\u3001\u7C21\u55AE\u67E5\u8A62\u3001\u662F\u975E\u984C\u3001\u55AE\u4E00\u4E8B\u5BE6\u67E5\u8A62
- 4\u20136\uFF1A\u9700\u8981\u89E3\u91CB\u6982\u5FF5\u3001\u7C21\u55AE\u6458\u8981\u3001\u57FA\u672C\u7A0B\u5F0F\u78BC\u7247\u6BB5\u3001\u4E00\u822C\u6027\u5EFA\u8B70
- 7\u201310\uFF1A\u591A\u6B65\u9A5F\u63A8\u7406\u3001\u8907\u96DC\u7A0B\u5F0F\u5BE6\u4F5C\u3001\u6578\u5B78\u8B49\u660E\u3001\u9700\u8981\u6DF1\u5EA6\u5206\u6790\u6216\u8DE8\u9818\u57DF\u6574\u5408\u7684\u4EFB\u52D9

\u7D1A\u8DDD\u9078\u64C7\uFF1A
- small\uFF1A0\u20133 \u5206\uFF0C\u4F4E\u6210\u672C\u5FEB\u901F\u56DE\u7B54
- medium\uFF1A4\u20136 \u5206\uFF0C\u54C1\u8CEA\u8207\u901F\u5EA6\u5E73\u8861
- large\uFF1A7\u201310 \u5206\uFF0C\u6DF1\u5EA6\u63A8\u7406\u3001\u8907\u96DC coding\u3001\u9577\u4EFB\u52D9

\u6CE8\u610F\u4E8B\u9805\uFF1A
- \u82E5\u8A0A\u606F\u672C\u8EAB\u7C21\u77ED\uFF0C\u4F46\u5C0D\u8A71\u8108\u7D61\u986F\u793A\u662F\u8907\u96DC\u4EFB\u52D9\u7684\u5EF6\u4F38\uFF0C\u8ACB\u8A55\u4F30\u6574\u500B\u4EFB\u52D9\u7684\u96E3\u5EA6
- \u8A55\u5206\u8981\u4FDD\u5B88\uFF1A\u5BE7\u53EF\u4F4E\u4F30\u8B93\u8F03\u5C0F\u6A21\u578B\u5148\u8A66\uFF0C\u4E5F\u4E0D\u8981\u52D5\u8F12\u7D66\u9AD8\u5206\u6D6A\u8CBB\u5927\u6A21\u578B
- model \u5FC5\u9808\u5F9E\u4F7F\u7528\u8005\u8A0A\u606F\u63D0\u4F9B\u7684\u53EF\u9078\u6A21\u578B\u6E05\u55AE\u4E2D\u6311\u9078\uFF0C\u4E0D\u5F97\u81EA\u5275\u6A21\u578B\u540D\u7A31
- \u82E5\u540C\u7D1A\u8DDD\u6709\u591A\u500B\u6A21\u578B\uFF0C\u4F9D\u6A21\u578B\u8AAA\u660E\u6311\u9078\u8207\u4EFB\u52D9\u7279\u6027\u6700\u5339\u914D\u7684\u4E00\u500B

\u8F38\u51FA\u683C\u5F0F\uFF08\u56B4\u683C\u9075\u5B88\uFF0C\u4E0D\u5F97\u6709\u591A\u9918\u6587\u5B57\uFF09\uFF1A
{"score":\u6578\u5B57,"route":"small|medium|large","model":"\u6A21\u578B alias","reason":"\u4E00\u53E5\u8A71\u8AAA\u660E"}`;
function parseJudge(raw) {
  for (const candidate of [raw, raw.replace(/```(?:json)?|```/g, "").trim(), raw.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
    }
  }
  return null;
}
__name(parseJudge, "parseJudge");
function modelOptionsText() {
  return Object.entries(MODEL_CANDIDATES).map(([route, aliases]) => `${route}:
${aliases.map((alias) => `- ${alias}: ${MODEL_NOTES[alias]}`).join("\n")}`).join("\n");
}
__name(modelOptionsText, "modelOptionsText");
function routeFromScore(config, score) {
  const tiny = config.threshold_tiny;
  const medium = Number(config.threshold_medium ?? 4);
  const large = Number(config.threshold_large ?? 7);
  if (tiny != null && score < Number(tiny)) return "tiny";
  if (score >= large) return "large";
  if (score >= medium) return "medium";
  return "small";
}
__name(routeFromScore, "routeFromScore");
export async function loadRoutingConfig(env) {
  const defaults = { threshold_tiny: null, threshold_medium: 4, threshold_large: 7, force_model: null, prefer_local: false };
  const row = await env.DB.prepare("SELECT value_json FROM app_config WHERE key='routing'").first();
  try {
    return { ...defaults, ...JSON.parse(row?.value_json || "{}") };
  } catch {
    return defaults;
  }
}
__name(loadRoutingConfig, "loadRoutingConfig");
function selectModel(config, parsed, isAdmin) {
  const force = isAdmin ? config.force_model : null;
  if (force && MODEL_TO_ROUTE[force]) return { route: MODEL_TO_ROUTE[force], model: force };
  const requestedRoute = MODEL_CANDIDATES[parsed.route] ? parsed.route : routeFromScore(config, parsed.score);
  const route = ["small", "medium", "large"].includes(force) ? force : requestedRoute;
  const candidates = MODEL_CANDIDATES[route] || MODEL_CANDIDATES.small;
  return { route, model: candidates.includes(parsed.model) ? parsed.model : candidates[0] };
}
__name(selectModel, "selectModel");
export async function classifyDifficulty(env, message2, history, config, isAdmin = false) {
  const startedAt = Date.now();
  const context = (history || []).slice(-10).map((m2) => `${m2.role === "user" ? "\u4F7F\u7528\u8005" : "AI"}\uFF1A${String(m2.content || "").slice(0, 400)}`).join("\n");
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: openRouterHeaders(env),
      body: JSON.stringify({
        model: providerModel(JUDGE_ALIAS),
        max_tokens: 1024,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: JUDGE_SYSTEM_PROMPT },
          { role: "user", content: `${context ? `\u5C0D\u8A71\u6B77\u53F2\uFF08\u4F9B\u53C3\u8003\uFF09\uFF1A
"""
${context}
"""

` : ""}\u53EF\u9078\u6A21\u578B\uFF1A
${modelOptionsText()}

\u8ACB\u8A55\u4F30\u4EE5\u4E0B\u6700\u65B0\u8A0A\u606F\u7684\u96E3\u5EA6\u4E26\u9078\u64C7\u7D1A\u8DDD\u8207\u6A21\u578B\uFF1A
\`\`\`
${message2}
\`\`\`` }
        ]
      })
    });
    if (!response.ok) throw new Error(`judge HTTP ${response.status}`);
    const data = await response.json(), parsed = parseJudge(data.choices?.[0]?.message?.content || "");
    if (!parsed) throw new Error("judge JSON parse failed");
    parsed.score = Math.max(0, Math.min(10, Number(parsed.score ?? 5)));
    const selected = selectModel(config, parsed, isAdmin);
    return { score: parsed.score, route: selected.route, model: selected.model, reason: String(parsed.reason || ""), judge_model: JUDGE_ALIAS, judge_elapsed_ms: Date.now() - startedAt, usage: { input_tokens: data.usage?.prompt_tokens || 0, output_tokens: data.usage?.completion_tokens || 0 } };
  } catch (error2) {
    console.error("difficulty judge failed", error2);
    const parsed = { score: 5, route: null, model: null }, selected = selectModel(config, parsed, isAdmin);
    return { score: 5, route: selected.route, model: selected.model, reason: "Judge \u66AB\u6642\u7121\u6CD5\u5B8C\u6210\u5206\u6790\uFF0C\u4F7F\u7528\u4E2D\u7B49\u96E3\u5EA6\u4F5C\u70BA\u5B89\u5168\u9810\u8A2D", judge_model: JUDGE_ALIAS, judge_elapsed_ms: Date.now() - startedAt, usage: { input_tokens: 0, output_tokens: 0 } };
  }
}
__name(classifyDifficulty, "classifyDifficulty");
