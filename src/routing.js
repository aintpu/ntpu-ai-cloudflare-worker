import { JUDGE_ALIAS, MODEL_CANDIDATES, MODEL_NOTES, MODEL_TO_ROUTE, openRouterHeaders, providerModel } from "./models.js";

const JUDGE_SYSTEM_PROMPT = `你是一個路由決策模型，專門負責評估使用者訊息的任務難度，決定要交給哪個級距與哪個回答模型處理。

你的唯一工作是輸出路由 JSON，不要回答使用者的問題。

評分標準（0–10）：
- 0–3：閒聊、問候、簡單查詢、是非題、單一事實查詢
- 4–6：需要解釋概念、簡單摘要、基本程式碼片段、一般性建議
- 7–10：多步驟推理、複雜程式實作、數學證明、需要深度分析或跨領域整合的任務

級距選擇：
- small：0–3 分，低成本快速回答
- medium：4–6 分，品質與速度平衡
- large：7–10 分，深度推理、複雜 coding、長任務

注意事項：
- 若訊息本身簡短，但對話脈絡顯示是複雜任務的延伸，請評估整個任務的難度
- 評分要保守：寧可低估讓較小模型先試，也不要動輒給高分浪費大模型
- model 必須從使用者訊息提供的可選模型清單中挑選，不得自創模型名稱
- 若同級距有多個模型，依模型說明挑選與任務特性最匹配的一個

輸出格式（嚴格遵守，不得有多餘文字）：
{"score":數字,"route":"small|medium|large","model":"模型 alias","reason":"一句話說明"}`;

function parseJudge(raw) {
  for (const candidate of [raw, raw.replace(/```(?:json)?|```/g, "").trim(), raw.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
}

function modelOptionsText() {
  return Object.entries(MODEL_CANDIDATES).map(([route, aliases]) => `${route}:\n${aliases.map(alias => `- ${alias}: ${MODEL_NOTES[alias]}`).join("\n")}`).join("\n");
}

export function routeFromScore(config, score) {
  const tiny = config.threshold_tiny;
  const medium = Number(config.threshold_medium ?? 4);
  const large = Number(config.threshold_large ?? 7);
  if (tiny != null && score < Number(tiny)) return "tiny";
  if (score >= large) return "large";
  if (score >= medium) return "medium";
  return "small";
}

export async function loadRoutingConfig(env) {
  const defaults = { threshold_tiny:null, threshold_medium:4, threshold_large:7, force_model:null, prefer_local:false };
  const row = await env.DB.prepare("SELECT value_json FROM app_config WHERE key='routing'").first();
  try { return { ...defaults, ...JSON.parse(row?.value_json || "{}") }; } catch { return defaults; }
}

function selectModel(config, parsed, isAdmin) {
  const force = isAdmin ? config.force_model : null;
  if (force && MODEL_TO_ROUTE[force]) return { route:MODEL_TO_ROUTE[force], model:force };
  const requestedRoute = MODEL_CANDIDATES[parsed.route] ? parsed.route : routeFromScore(config, parsed.score);
  const route = ["small","medium","large"].includes(force) ? force : requestedRoute;
  const candidates = MODEL_CANDIDATES[route] || MODEL_CANDIDATES.small;
  return { route, model:candidates.includes(parsed.model) ? parsed.model : candidates[0] };
}

export async function classifyDifficulty(env, message, history, config, isAdmin = false) {
  const startedAt = Date.now();
  const context = (history || []).slice(-10).map(m => `${m.role === "user" ? "使用者" : "AI"}：${String(m.content || "").slice(0,400)}`).join("\n");
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method:"POST", headers:openRouterHeaders(env),
      body:JSON.stringify({
        model:providerModel(JUDGE_ALIAS), max_tokens:1024, response_format:{type:"json_object"},
        messages:[
          {role:"system",content:JUDGE_SYSTEM_PROMPT},
          {role:"user",content:`${context ? `對話歷史（供參考）：\n\"\"\"\n${context}\n\"\"\"\n\n` : ""}可選模型：\n${modelOptionsText()}\n\n請評估以下最新訊息的難度並選擇級距與模型：\n\`\`\`\n${message}\n\`\`\``},
        ],
      }),
    });
    if (!response.ok) throw new Error(`judge HTTP ${response.status}`);
    const data=await response.json(), parsed=parseJudge(data.choices?.[0]?.message?.content || "");
    if (!parsed) throw new Error("judge JSON parse failed");
    parsed.score=Math.max(0,Math.min(10,Number(parsed.score ?? 5)));
    const selected=selectModel(config,parsed,isAdmin);
    return { score:parsed.score, route:selected.route, model:selected.model, reason:String(parsed.reason||""), judge_model:JUDGE_ALIAS, judge_elapsed_ms:Date.now()-startedAt, usage:{input_tokens:data.usage?.prompt_tokens||0,output_tokens:data.usage?.completion_tokens||0} };
  } catch (error) {
    console.error("difficulty judge failed",error);
    const parsed={score:5,route:null,model:null}, selected=selectModel(config,parsed,isAdmin);
    return { score:5,route:selected.route,model:selected.model,reason:"Judge 暫時無法完成分析，使用中等難度作為安全預設",judge_model:JUDGE_ALIAS,judge_elapsed_ms:Date.now()-startedAt,usage:{input_tokens:0,output_tokens:0} };
  }
}
