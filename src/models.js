export const JUDGE_ALIAS = "judge-model";
export const MEMORY_ALIAS = "memory-model";

export const MODEL_CANDIDATES = {
  small: ["cloud-small-claude", "cloud-small-gemini"],
  medium: ["cloud-medium-claude", "cloud-medium-gemini"],
  large: ["cloud-large-claude", "cloud-large-gemini"],
};

export const MODEL_PROVIDER_IDS = {
  [JUDGE_ALIAS]: "mistralai/mistral-small-2603",
  [MEMORY_ALIAS]: "google/gemini-2.5-flash",
  "cloud-small-claude": "anthropic/claude-haiku-4.5",
  "cloud-small-gemini": "google/gemini-3.1-flash-lite",
  "cloud-medium-claude": "anthropic/claude-sonnet-5",
  "cloud-medium-gemini": "google/gemini-3.5-flash",
  "cloud-large-claude": "anthropic/claude-opus-4.8",
  "cloud-large-gemini": "google/gemini-2.5-pro",
};

// OpenRouter list prices in USD per 1M tokens. Snapshot from the official
// model catalog; keep the date visible in the admin panel so costs are clearly
// presented as estimates rather than invoices.
export const OPENROUTER_PRICING = {
  as_of: "2026-08-12",
  source: "https://openrouter.ai/api/v1/models",
  usd_per_million: {
    "mistralai/mistral-small-2603": { input: 0.15, output: 0.60 },
    "google/gemini-2.5-flash": { input: 0.30, output: 2.50 },
    "anthropic/claude-haiku-4.5": { input: 1.00, output: 5.00 },
    "google/gemini-3.1-flash-lite": { input: 0.25, output: 1.50 },
    "anthropic/claude-sonnet-5": { input: 2.00, output: 10.00 },
    "google/gemini-3.5-flash": { input: 1.50, output: 9.00 },
    "anthropic/claude-opus-4.8": { input: 5.00, output: 25.00 },
    "google/gemini-2.5-pro": { input: 1.25, output: 10.00 },
  },
};

export const MODEL_NOTES = {
  "cloud-small-claude": "Claude Haiku 4.5：快速、省成本，適合簡單問答與短任務",
  "cloud-small-gemini": "Gemini 3.1 Flash-Lite：最快速、成本低，適合大量輕量任務",
  "cloud-medium-claude": "Claude Sonnet 5：品質穩定，適合一般推理、寫作與程式任務",
  "cloud-medium-gemini": "Gemini 3.5 Flash：低延遲且能力均衡，適合中等複雜任務",
  "cloud-large-claude": "Claude Opus 4.8：高品質深度推理、長任務與複雜 coding",
  "cloud-large-gemini": "Gemini 2.5 Pro：深度推理與 coding，適合複雜任務",
};

export const MODEL_TO_ROUTE = Object.fromEntries(
  Object.entries(MODEL_CANDIDATES).flatMap(([route, aliases]) => aliases.map(alias => [alias, route])),
);

export function providerModel(alias) {
  return MODEL_PROVIDER_IDS[alias] || alias;
}

export function openRouterHeaders(env) {
  return {
    authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    "content-type": "application/json",
    "http-referer": "https://ntpu.ai",
    "x-title": "NTPU AI",
  };
}
