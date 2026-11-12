import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ImageInput, MediaType } from "./digitize.ts";

const run = promisify(execFile);
const SUPPORTED = new Set<string>(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// Normalizes any phone photo (HEIC, huge PNG) to a <=1600px JPEG with macOS `sips`.
// Without sips (non-macOS) the original bytes are used when the type is directly supported.
export async function prepareImage(file: File): Promise<ImageInput> {
  const bytes = Buffer.from(await file.arrayBuffer());
  const dir = await mkdtemp(path.join(tmpdir(), "note-digitizer-"));
  try {
    const src = path.join(dir, "in");
    const out = path.join(dir, "out.jpg");
    await writeFile(src, bytes);
    await run("sips", ["-Z", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "85", src, "--out", out]);
    return { data: await readFile(out), mediaType: "image/jpeg" };
  } catch {
    if (SUPPORTED.has(file.type)) return { data: bytes, mediaType: file.type as MediaType };
    throw new Error(`Unsupported image type: ${file.type || "unknown"}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
