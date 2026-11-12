import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../app.ts";
import type { DigitizeEvent, Stats } from "../digitize.ts";

const STATS: Stats = {
  wallMs: 1000,
  apiMs: 900,
  turns: 2,
  costUsd: 0.01,
  tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, thinking: 0 },
  byModel: [],
};

const fakeDigitize = (events: DigitizeEvent[]) =>
  async function* () {
    for (const e of events) yield e;
  } as never;

const fakePrepare = async () => ({ data: Buffer.from("x"), mediaType: "image/jpeg" as const });

function upload(bytes = "x", type = "image/jpeg") {
  const form = new FormData();
  form.append("photo", new File([bytes], "note.jpg", { type }));
  return { method: "POST", body: form };
}

async function sseEvents(res: Response) {
  const text = await res.text();
  return text
    .split("\n\n")
    .map((chunk) => chunk.split("\n").find((l) => l.startsWith("data:")))
    .filter((l): l is string => Boolean(l))
    .map((l) => JSON.parse(l.slice(5).trim()) as DigitizeEvent);
}

describe("POST /digitize", () => {
  it("streams a rejected event for a non-handwritten photo", async () => {
    const app = createApp({
      prepareImage: fakePrepare,
      digitize: fakeDigitize([{ kind: "rejected", reason: "Printed text", stats: STATS }]),
    });
    const res = await app.request("/digitize", upload());
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const events = await sseEvents(res);
    assert.deepEqual(events.map((e) => e.kind), ["rejected"]);
  });

  it("streams progress, then the result with stats", async () => {
    const app = createApp({
      prepareImage: fakePrepare,
      digitize: fakeDigitize([
        { kind: "init", model: "claude-sonnet-5-5", apiKeySource: "none" },
        { kind: "thinking", text: "reading" },
        { kind: "result", markdown: "# Note", stats: STATS },
      ]),
    });
    const events = await sseEvents(await app.request("/digitize", upload()));
    assert.deepEqual(events.map((e) => e.kind), ["init", "thinking", "result"]);
    const last = events.at(-1);
    assert.ok(last && last.kind === "result");
    assert.equal(last.stats.costUsd, 0.01);
  });

  it("rejects a request without a photo and an unsupported file type", async () => {
    const app = createApp({
      prepareImage: async () => {
        throw new Error("Unsupported image type: text/plain");
      },
      digitize: fakeDigitize([]),
    });
    const empty = await app.request("/digitize", { method: "POST", body: new FormData() });
    assert.equal(empty.status, 400);
    const bad = await app.request("/digitize", upload("hello", "text/plain"));
    assert.equal(bad.status, 415);
  });

  it("allows one run at a time", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const app = createApp({
      prepareImage: fakePrepare,
      digitize: (async function* () {
        await gate;
        yield { kind: "result", markdown: "x", stats: STATS } as DigitizeEvent;
      }) as never,
    });
    const first = await app.request("/digitize", upload());
    const second = await app.request("/digitize", upload());
    assert.equal(second.status, 429);
    release();
    await first.text();
  });
});
