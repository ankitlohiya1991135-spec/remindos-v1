/**
 * Token-count + cost estimation helpers.
 *
 * IMPORTANT: This is a HEURISTIC. We approximate tokens from message
 * content length only. The real prompt sent to NVIDIA NIM also includes
 * the wiki context, the LIFE OS digest, and a JSON dump (built in
 * `apps/web/app/api/chat/route.ts`) — typically 5–15k extra chars per
 * turn. Real upstream usage is therefore HIGHER than what we report.
 *
 * Treat the "estimatedCostUsd" we compute as a LOWER BOUND. For accurate
 * accounting, capture the `usage` object from the NIM API response and
 * persist it on each `chatMessages` row — separate ticket.
 */

/** Rough rule of thumb: ~4 characters per token for English-ish text. */
const CHARS_PER_TOKEN = 4;

/**
 * Default per-1M-token rates (USD). Override via env vars in production:
 *   NIM_INPUT_COST_PER_1M_TOKENS
 *   NIM_OUTPUT_COST_PER_1M_TOKENS
 *
 * Defaults are conservative placeholders for `mistralai/mistral-medium-3.5`.
 * Update when you have real billing data from NVIDIA NIM.
 */
const DEFAULT_INPUT_RATE_PER_1M = 0.4;   // USD
const DEFAULT_OUTPUT_RATE_PER_1M = 2.0;  // USD

export interface ChatRowForTokenEstimate {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

function readEnvNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Estimate tokens + USD cost from a list of chat messages.
 * "input" = user + system messages (what we'd send to the model).
 * "output" = assistant messages (what the model generated).
 */
export function estimateTokens(
  rows: ReadonlyArray<ChatRowForTokenEstimate>,
): TokenEstimate {
  let inputChars = 0;
  let outputChars = 0;
  for (const row of rows) {
    const len = row.content.length;
    if (row.role === "assistant") outputChars += len;
    else inputChars += len;
  }
  const inputTokens = Math.ceil(inputChars / CHARS_PER_TOKEN);
  const outputTokens = Math.ceil(outputChars / CHARS_PER_TOKEN);
  const inputRate = readEnvNumber("NIM_INPUT_COST_PER_1M_TOKENS", DEFAULT_INPUT_RATE_PER_1M);
  const outputRate = readEnvNumber("NIM_OUTPUT_COST_PER_1M_TOKENS", DEFAULT_OUTPUT_RATE_PER_1M);
  const estimatedCostUsd =
    (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000, // round to 6 decimals
  };
}
