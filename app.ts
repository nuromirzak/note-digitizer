import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { digitize as realDigitize } from "./digitize.ts";
import { prepareImage as realPrepare } from "./image.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 12 * 1024 * 1024;

type Deps = { digitize?: typeof realDigitize; prepareImage?: typeof realPrepare };

export function createApp(deps: Deps = {}) {
  const digitize = deps.digitize ?? realDigitize;
  const prepareImage = deps.prepareImage ?? realPrepare;
  const app = new Hono();
  let busy = false;

  app.get("/", async (c) => c.html(await readFile(path.join(here, "public/index.html"), "utf8")));
  app.get("/vendor/mermaid.js", async (c) =>
    c.body(await readFile(path.join(here, "node_modules/mermaid/dist/mermaid.min.js")), 200, { "content-type": "text/javascript" }));
  app.get("/vendor/marked.js", async (c) =>
    c.body(await readFile(path.join(here, "node_modules/marked/lib/marked.umd.js")), 200, { "content-type": "text/javascript" }));

  app.post("/digitize", async (c) => {
    if (busy) return c.json({ error: "Busy, try again in a minute" }, 429);
    const file = (await c.req.formData()).get("photo");
    if (!(file instanceof File) || file.size === 0) return c.json({ error: "No photo" }, 400);
    if (file.size > MAX_BYTES) return c.json({ error: "Photo over 12 MB" }, 413);

    let image;
    try {
      image = await prepareImage(file);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 415);
    }

    busy = true;
    return streamSSE(c, async (stream) => {
      const gen = digitize(image);
      stream.onAbort(() => void gen.return(undefined));
      try {
        for await (const event of gen) await stream.writeSSE({ data: JSON.stringify(event) });
      } catch (e) {
        await stream.writeSSE({ data: JSON.stringify({ kind: "error", message: e instanceof Error ? e.message : String(e) }) });
      } finally {
        busy = false;
      }
    });
  });

  return app;
}
