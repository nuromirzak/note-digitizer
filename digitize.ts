import { tmpdir } from "node:os";
import { query as sdkQuery, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// The typed contract between the model and the app. Passed to the SDK as `outputFormat`
// and used again to validate what comes back.
export const DigitizeOutput = z.object({
  is_handwritten: z.boolean().describe("true only for a photo or scan of handwriting"),
  reason: z.string().describe("One short sentence in English explaining the verdict"),
  markdown: z
    .string()
    .describe("The digitized note as Markdown with at most one mermaid block; empty string when is_handwritten is false"),
});
export type DigitizeOutput = z.infer<typeof DigitizeOutput>;

export const SYSTEM_PROMPT = `You digitize photos of handwritten notes. The image is attached to the user message.

First decide whether it is handwriting (pen or pencil on paper, whiteboard, stylus drawing). Printed or typed text, screenshots, document scans, logos, people, scenery and blank pages are NOT handwritten: set is_handwritten=false, explain in reason, and set markdown to an empty string.

If it is handwritten, fill markdown:
- Transcribe all text. Keep the original language of each line, never translate.
- Handwriting produces slips: fix spelling, grammar and half-written or obviously wrong words using context. Do not rephrase or add ideas.
- Reproduce structure: headings, numbered lists, nested bullets, keep the numbering from the page.
- Every diagram, graph, flow or arrow structure goes into ONE fenced mermaid block (flowchart TD unless another type fits). Quote labels with double quotes, follow arrow directions exactly, connect only what the page connects.
- Only a word that is truly unreadable and cannot be inferred gets marked [?word?].`;

export type MediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export type ImageInput = { data: Buffer; mediaType: MediaType };

export type Stats = {
  wallMs: number;
  apiMs: number;
  turns: number;
  costUsd: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; thinking: number };
  byModel: { model: string; costUsd: number; inputTokens: number; outputTokens: number }[];
};

export type DigitizeEvent =
  | { kind: "init"; model: string; apiKeySource: string }
  | { kind: "thinking"; text: string }
  | { kind: "result"; markdown: string; stats: Stats }
  | { kind: "rejected"; reason: string; stats: Stats }
  | { kind: "error"; message: string };

// Only the fields of the SDK result message that we read, so tests can fake it.
export type ResultLike = {
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
  modelUsage: Record<string, { costUSD: number; inputTokens: number; outputTokens: number }>;
};

export function normalizeStats(m: ResultLike): Stats {
  return {
    wallMs: m.duration_ms,
    apiMs: m.duration_api_ms,
    turns: m.num_turns,
    costUsd: m.total_cost_usd,
    tokens: {
      input: m.usage.input_tokens,
      output: m.usage.output_tokens,
      cacheRead: m.usage.cache_read_input_tokens,
      cacheWrite: m.usage.cache_creation_input_tokens,
      thinking: m.usage.output_tokens_details?.thinking_tokens ?? 0,
    },
    byModel: Object.entries(m.modelUsage).map(([model, u]) => ({
      model,
      costUsd: u.costUSD,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
    })),
  };
}

// By default the child process gets no API key, so the SDK uses your own Claude login (plan limits).
// Set NOTE_DIGITIZER_USE_API_KEY=1 to keep ANTHROPIC_API_KEY and bill the API instead,
// which is what Anthropic asks for when the app serves other people.
export function subscriptionEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.NOTE_DIGITIZER_USE_API_KEY === "1") return env;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

type QueryFn = (args: Parameters<typeof sdkQuery>[0]) => AsyncIterable<SDKMessage> & { close?: () => void };

export async function* digitize(image: ImageInput, deps: { queryFn?: QueryFn } = {}): AsyncGenerator<DigitizeEvent> {
  const queryFn: QueryFn = deps.queryFn ?? sdkQuery;

  // The image goes inline in the user message. Reading it through the Read tool cost 60-80k
  // cache tokens ($0.33) versus ~2k ($0.009) inline, and needed an extra turn.
  async function* input() {
    yield {
      type: "user" as const,
      parent_tool_use_id: null,
      message: {
        role: "user" as const,
        content: [
          { type: "image" as const, source: { type: "base64" as const, media_type: image.mediaType, data: image.data.toString("base64") } },
          { type: "text" as const, text: "Digitize this note." },
        ],
      },
    };
  }

  const q = queryFn({
    prompt: input(),
    options: {
      cwd: tmpdir(),
      env: subscriptionEnv(),
      systemPrompt: SYSTEM_PROMPT,
      permissionMode: "auto",
      tools: [],
      settingSources: [],
      thinking: { type: "adaptive", display: "summarized" },
      includePartialMessages: true,
      maxTurns: 3,
      // draft-7: the CLI validator rejects the draft 2020-12 `$schema` that zod emits by default
      outputFormat: { type: "json_schema", schema: z.toJSONSchema(DigitizeOutput, { target: "draft-7" }) },
    },
  });

  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") {
        yield { kind: "init", model: m.model, apiKeySource: m.apiKeySource };
      } else if (m.type === "stream_event") {
        const d = (m.event as { delta?: { type?: string; thinking?: string } }).delta;
        if (d?.type === "thinking_delta" && d.thinking) yield { kind: "thinking", text: d.thinking };
      } else if (m.type === "result") {
        if (m.subtype !== "success") {
          yield { kind: "error", message: `agent failed: ${m.subtype}` };
          return;
        }
        const parsed = DigitizeOutput.safeParse(m.structured_output);
        if (!parsed.success) {
          yield { kind: "error", message: `Model returned invalid output: ${parsed.error.message}` };
          return;
        }
        const stats = normalizeStats(m as unknown as ResultLike);
        const out = parsed.data;
        if (!out.is_handwritten) {
          yield { kind: "rejected", reason: out.reason, stats };
        } else if (!out.markdown.trim()) {
          yield { kind: "error", message: "Model marked the image as handwritten but returned no text" };
        } else {
          yield { kind: "result", markdown: out.markdown.trim(), stats };
        }
        return;
      }
    }
    yield { kind: "error", message: "Agent finished without a result" };
  } finally {
    q.close?.();
  }
}
