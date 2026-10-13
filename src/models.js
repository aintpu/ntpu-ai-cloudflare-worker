import { __name } from "./utils.js";

export var JUDGE_ALIAS = "judge-model";
export var MEMORY_ALIAS = "memory-model";
export var MODEL_CANDIDATES = {
  small: ["cloud-small-claude", "cloud-small-gemini"],
  medium: ["cloud-medium-claude", "cloud-medium-gemini"],
  large: ["cloud-large-claude", "cloud-large-gemini"]
};
export var MODEL_PROVIDER_IDS = {
  [JUDGE_ALIAS]: "mistralai/mistral-small-2603",
  [MEMORY_ALIAS]: "google/gemini-2.5-flash",
  "cloud-small-claude": "anthropic/claude-haiku-4.5",
  "cloud-small-gemini": "google/gemini-3.1-flash-lite",
  "cloud-medium-claude": "anthropic/claude-sonnet-5",
  "cloud-medium-gemini": "google/gemini-3.5-flash",
  "cloud-large-claude": "anthropic/claude-opus-4.8",
  "cloud-large-gemini": "google/gemini-2.5-pro"
};
export var OPENROUTER_PRICING = {
  as_of: "2026-08-12",
  source: "https://openrouter.ai/api/v1/models",
  usd_per_million: {
    "mistralai/mistral-small-2603": { input: 0.15, output: 0.6 },
    "google/gemini-2.5-flash": { input: 0.3, output: 2.5 },
    "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
    "google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
    "anthropic/claude-sonnet-5": { input: 2, output: 10 },
    "google/gemini-3.5-flash": { input: 1.5, output: 9 },
    "anthropic/claude-opus-4.8": { input: 5, output: 25 },
    "google/gemini-2.5-pro": { input: 1.25, output: 10 }
  }
};
export var MODEL_NOTES = {
  "cloud-small-claude": "Claude Haiku 4.5\uFF1A\u5FEB\u901F\u3001\u7701\u6210\u672C\uFF0C\u9069\u5408\u7C21\u55AE\u554F\u7B54\u8207\u77ED\u4EFB\u52D9",
  "cloud-small-gemini": "Gemini 3.1 Flash-Lite\uFF1A\u6700\u5FEB\u901F\u3001\u6210\u672C\u4F4E\uFF0C\u9069\u5408\u5927\u91CF\u8F15\u91CF\u4EFB\u52D9",
  "cloud-medium-claude": "Claude Sonnet 5\uFF1A\u54C1\u8CEA\u7A69\u5B9A\uFF0C\u9069\u5408\u4E00\u822C\u63A8\u7406\u3001\u5BEB\u4F5C\u8207\u7A0B\u5F0F\u4EFB\u52D9",
  "cloud-medium-gemini": "Gemini 3.5 Flash\uFF1A\u4F4E\u5EF6\u9072\u4E14\u80FD\u529B\u5747\u8861\uFF0C\u9069\u5408\u4E2D\u7B49\u8907\u96DC\u4EFB\u52D9",
  "cloud-large-claude": "Claude Opus 4.8\uFF1A\u9AD8\u54C1\u8CEA\u6DF1\u5EA6\u63A8\u7406\u3001\u9577\u4EFB\u52D9\u8207\u8907\u96DC coding",
  "cloud-large-gemini": "Gemini 2.5 Pro\uFF1A\u6DF1\u5EA6\u63A8\u7406\u8207 coding\uFF0C\u9069\u5408\u8907\u96DC\u4EFB\u52D9"
};
export var MODEL_TO_ROUTE = Object.fromEntries(
  Object.entries(MODEL_CANDIDATES).flatMap(([route, aliases]) => aliases.map((alias) => [alias, route]))
);
export function providerModel(alias) {
  return MODEL_PROVIDER_IDS[alias] || alias;
}
__name(providerModel, "providerModel");
export function openRouterHeaders(env) {
  return {
    authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    "content-type": "application/json",
    "http-referer": "https://ntpu.ai",
    "x-title": "NTPU AI"
  };
}
__name(openRouterHeaders, "openRouterHeaders");
