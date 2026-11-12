// Live evals: call the real model on your Claude login, so they are slow and cost plan quota.
// Run with `npm run eval`. They are NOT part of `npm test`.
//
// Pass thresholds and why:
// - printed image must be rejected: it is a hard product rule, a false accept is a failure.
// - hard words must come out spelled correctly: the sample is a real scrawl where "phenomenal" and
//   "scribblings" are barely legible, so only context-based correction gets them right.
// - no mermaid block: the sample has no diagram, inventing one is a hallucination.
// - cost < $0.10: measured $0.009-0.016 per run with the image inline; $0.33 was the old Read-tool path,
//   so anything near 0.10 means that regression is back.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { digitize, type DigitizeEvent, type ImageInput } from "../../digitize.ts";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
const load = async (name: string, mediaType: ImageInput["mediaType"]): Promise<ImageInput> => ({
  data: await readFile(path.join(fixtures, name)),
  mediaType,
});

async function run(image: ImageInput) {
  const events: DigitizeEvent[] = [];
  for await (const e of digitize(image)) events.push(e);
  return events;
}

describe("live: not handwritten", () => {
  it("rejects printed text", async () => {
    const events = await run(await load("printed-text.png", "image/png"));
    const rejected = events.find((e) => e.kind === "rejected");
    assert.ok(rejected, `expected rejected, got ${events.map((e) => e.kind).join(",")}`);
    assert.equal(events.some((e) => e.kind === "result"), false);
  });
});

describe("live: handwritten note", { concurrency: false }, async () => {
  const events = await run(await load("handwriting-sample.webp", "image/webp"));
  const result = events.find((e) => e.kind === "result");

  it("is accepted as handwriting", () => {
    assert.ok(result && result.kind === "result", `got ${events.map((e) => e.kind).join(",")}`);
  });

  it("transcribes the content and corrects hard words from context", () => {
    assert.ok(result && result.kind === "result");
    for (const word of [/unusually/i, /markdown editor/i, /Tiago Forte/i, /phenomenal/i, /scribbl/i, /CRAFT/i]) {
      assert.match(result.markdown, word);
    }
  });

  it("does not mark more than a couple of words unreadable and invents no diagram", () => {
    assert.ok(result && result.kind === "result");
    assert.ok((result.markdown.match(/\[\?/g) ?? []).length <= 2);
    assert.doesNotMatch(result.markdown, /```mermaid/);
  });

  it("reports time, tokens and a sane cost", () => {
    assert.ok(result && result.kind === "result");
    const { stats } = result;
    assert.ok(stats.wallMs > 0);
    assert.ok(stats.tokens.output > 0);
    assert.ok(stats.tokens.cacheWrite + stats.tokens.input > 0);
    assert.ok(stats.costUsd > 0 && stats.costUsd < 0.1, `cost ${stats.costUsd}`);
  });
});
