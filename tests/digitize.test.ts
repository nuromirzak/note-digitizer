import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { digitize, normalizeStats, SYSTEM_PROMPT, type DigitizeEvent, type ImageInput } from "../digitize.ts";

const image: ImageInput = { data: Buffer.from("fake-bytes"), mediaType: "image/jpeg" };

const RESULT_BASE = {
  type: "result",
  subtype: "success",
  duration_ms: 4200,
  duration_api_ms: 3900,
  num_turns: 2,
  total_cost_usd: 0.0154,
  usage: {
    input_tokens: 2,
    output_tokens: 392,
    cache_read_input_tokens: 10,
    cache_creation_input_tokens: 2826,
    output_tokens_details: { thinking_tokens: 120 },
  },
  modelUsage: {
    "claude-sonnet-5-5": { costUSD: 0.0153, inputTokens: 2, outputTokens: 392 },
    "claude-haiku-5-5": { costUSD: 0.0001, inputTokens: 1200, outputTokens: 18 },
  },
};

type Captured = { options?: Record<string, any>; prompt?: AsyncIterable<any> };

// Fake of the SDK `query`: yields given messages and records the options it was called with.
function fakeQuery(messages: object[], captured: Captured = {}) {
  return (args: any) => {
    captured.options = args.options;
    captured.prompt = args.prompt;
    return (async function* () {
      for (const m of messages) yield m as SDKMessage;
    })();
  };
}

async function collect(gen: AsyncGenerator<DigitizeEvent>) {
  const events: DigitizeEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

describe("not-handwritten flow", () => {
  it("rejects a non-handwritten image with the model's reason and still reports stats", async () => {
    const events = await collect(
      digitize(image, {
        queryFn: fakeQuery([
          { ...RESULT_BASE, structured_output: { is_handwritten: false, reason: "Printed laser text, not handwriting.", markdown: "" } },
        ]),
      }),
    );
    const rejected = events.find((e) => e.kind === "rejected");
    assert.ok(rejected && rejected.kind === "rejected");
    assert.equal(rejected.reason, "Printed laser text, not handwriting.");
    assert.equal(rejected.stats.turns, 2);
    assert.equal(events.some((e) => e.kind === "result"), false, "must not emit a result for rejected images");
  });

  it("tells the model how to classify non-handwriting", () => {
    assert.match(SYSTEM_PROMPT, /NOT handwritten/);
    assert.match(SYSTEM_PROMPT, /is_handwritten=false/);
  });

  it("errors when the model claims handwriting but returns no text", async () => {
    const events = await collect(
      digitize(image, {
        queryFn: fakeQuery([{ ...RESULT_BASE, structured_output: { is_handwritten: true, reason: "ok", markdown: "  " } }]),
      }),
    );
    assert.equal(events.at(-1)?.kind, "error");
  });
});

describe("autocorrect flow", () => {
  it("instructs the model to fix spelling and grammar from context, without rewording or translating", () => {
    assert.match(SYSTEM_PROMPT, /fix spelling, grammar/);
    assert.match(SYSTEM_PROMPT, /using context/);
    assert.match(SYSTEM_PROMPT, /Do not rephrase/);
    assert.match(SYSTEM_PROMPT, /never translate/);
  });

  it("returns the corrected markdown from the model unchanged apart from trimming", async () => {
    const corrected = "- Without money everything is useless\n\n```mermaid\nflowchart TD\n  A --> B\n```";
    const events = await collect(
      digitize(image, {
        queryFn: fakeQuery([{ ...RESULT_BASE, structured_output: { is_handwritten: true, reason: "ink notes", markdown: `\n${corrected}\n` } }]),
      }),
    );
    const result = events.find((e) => e.kind === "result");
    assert.ok(result && result.kind === "result");
    assert.equal(result.markdown, corrected);
  });
});

describe("run stats", () => {
  it("normalizes time, tokens, cost and per-model split", () => {
    const s = normalizeStats(RESULT_BASE as any);
    assert.equal(s.wallMs, 4200);
    assert.equal(s.apiMs, 3900);
    assert.equal(s.turns, 2);
    assert.equal(s.costUsd, 0.0154);
    assert.deepEqual(s.tokens, { input: 2, output: 392, cacheRead: 10, cacheWrite: 2826, thinking: 120 });
    assert.deepEqual(s.byModel.map((m) => m.model), ["claude-sonnet-5-5", "claude-haiku-5-5"]);
    assert.equal(s.byModel[1]?.costUsd, 0.0001);
  });

  it("defaults thinking tokens to 0 when the SDK omits them", () => {
    const { output_tokens_details: _omit, ...usage } = RESULT_BASE.usage;
    assert.equal(normalizeStats({ ...RESULT_BASE, usage } as any).tokens.thinking, 0);
  });

  it("attaches stats to the successful result event", async () => {
    const events = await collect(
      digitize(image, {
        queryFn: fakeQuery([{ ...RESULT_BASE, structured_output: { is_handwritten: true, reason: "ok", markdown: "# Note" } }]),
      }),
    );
    const result = events.find((e) => e.kind === "result");
    assert.ok(result && result.kind === "result");
    assert.equal(result.stats.tokens.cacheWrite, 2826);
    assert.equal(result.stats.costUsd, 0.0154);
  });
});

describe("agent contract", () => {
  it("sends the image inline, uses no tools, auto mode, and keeps the API key out of the child env", async () => {
    const captured: Captured = {};
    process.env.ANTHROPIC_API_KEY = "sk-test-should-be-stripped";
    try {
      await collect(
        digitize(image, {
          queryFn: fakeQuery([{ ...RESULT_BASE, structured_output: { is_handwritten: true, reason: "ok", markdown: "x" } }], captured),
        }),
      );
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    const opts = captured.options!;
    assert.equal(opts.permissionMode, "auto");
    assert.deepEqual(opts.tools, []);
    assert.deepEqual(opts.settingSources, []);
    assert.equal(opts.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(opts.outputFormat.type, "json_schema");
    assert.equal(opts.outputFormat.schema.$schema, "http://json-schema.org/draft-07/schema#");

    const first = (await captured.prompt![Symbol.asyncIterator]().next()).value;
    const block = first.message.content[0];
    assert.equal(block.type, "image");
    assert.equal(block.source.data, image.data.toString("base64"));
  });

  it("keeps the API key only when NOTE_DIGITIZER_USE_API_KEY=1", async () => {
    const run = async () => {
      const captured: Captured = {};
      await collect(
        digitize(image, {
          queryFn: fakeQuery([{ ...RESULT_BASE, structured_output: { is_handwritten: true, reason: "ok", markdown: "x" } }], captured),
        }),
      );
      return captured.options!.env.ANTHROPIC_API_KEY;
    };
    process.env.ANTHROPIC_API_KEY = "sk-test";
    try {
      assert.equal(await run(), undefined);
      process.env.NOTE_DIGITIZER_USE_API_KEY = "1";
      assert.equal(await run(), "sk-test");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.NOTE_DIGITIZER_USE_API_KEY;
    }
  });

  it("surfaces non-success agent results and invalid structured output as errors", async () => {
    const failed = await collect(digitize(image, { queryFn: fakeQuery([{ ...RESULT_BASE, subtype: "error_max_turns" }]) }));
    assert.deepEqual(failed, [{ kind: "error", message: "agent failed: error_max_turns" }]);

    const invalid = await collect(digitize(image, { queryFn: fakeQuery([{ ...RESULT_BASE, structured_output: { nope: 1 } }]) }));
    assert.equal(invalid[0]?.kind, "error");
  });
});
