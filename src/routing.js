const JUDGE_SYSTEM_PROMPT = `你是一個路由決策模型，專門負責評估使用者訊息的任務難度，決定要交給哪個級距處理。

你的唯一工作是輸出路由 JSON，不要回答使用者的問題。

評分標準（0–10）：
- 0–3：閒聊、問候、簡單查詢、是非題、單一事實查詢
- 4–6：需要解釋概念、簡單摘要、基本程式碼片段、一般性建議
- 7–10：多步驟推理、複雜程式實作、數學證明、需要深度分析或跨領域整合的任務

級距選擇：small 為 0–3 分、medium 為 4–6 分、large 為 7–10 分。
訊息雖短但若是複雜對話的延伸，須評估整體任務。評分應保守，不要動輒給高分。
只輸出：{"score":數字,"route":"small|medium|large","reason":"一句話說明"}`;

function responseText(data) {
  if (data.output_text) return data.output_text;
  return (data.output || []).flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text || "").join("");
}

function parseJudge(raw) {
  for (const candidate of [raw, raw.replace(/```(?:json)?|```/g, "").trim(), raw.match(/\{[\s\S]*\}/)?.[0]]) {
    if (!candidate) continue;
    try { return JSON.parse(candidate); } catch {}
  }
  return null;
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

export async function classifyDifficulty(env, message, history, config, answerModel, isAdmin = false) {
  const startedAt = Date.now();
  const judgeModel = env.OPENAI_JUDGE_MODEL || env.OPENAI_MODEL || answerModel;
  const context = (history || []).slice(-10).map(m => `${m.role === "user" ? "使用者" : "AI"}：${String(m.content || "").slice(0,400)}`).join("\n");
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method:"POST",
      headers:{ authorization:`Bearer ${env.OPENAI_API_KEY}`, "content-type":"application/json" },
      body:JSON.stringify({
        model:judgeModel,
        instructions:JUDGE_SYSTEM_PROMPT,
        input:`${context ? `對話歷史（供參考）：\n${context}\n\n` : ""}請評估以下最新訊息的難度：\n${message}`,
        max_output_tokens:1024,
        store:false,
      }),
    });
    if (!response.ok) throw new Error(`judge HTTP ${response.status}`);
    const data = await response.json(), parsed = parseJudge(responseText(data));
    if (!parsed) throw new Error("judge JSON parse failed");
    const score = Math.max(0, Math.min(10, Number(parsed.score ?? 5)));
    const requested = ["small","medium","large","tiny"].includes(parsed.route) ? parsed.route : null;
    const forced = isAdmin && ["small","medium","large","tiny"].includes(config.force_model) ? config.force_model : null;
    return {
      score,
      route:forced || requested || routeFromScore(config, score),
      model:answerModel,
      reason:String(parsed.reason || ""),
      judge_model:judgeModel,
      judge_elapsed_ms:Date.now()-startedAt,
      usage:{ input_tokens:data.usage?.input_tokens || 0, output_tokens:data.usage?.output_tokens || 0 },
    };
  } catch (error) {
    console.error("difficulty judge failed", error);
    const score = 5;
    return { score, route:routeFromScore(config,score), model:answerModel, reason:"Judge 暫時無法完成分析，使用中等難度作為安全預設", judge_model:judgeModel, judge_elapsed_ms:Date.now()-startedAt, usage:{input_tokens:0,output_tokens:0} };
  }
}
