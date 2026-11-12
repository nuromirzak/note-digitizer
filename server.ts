import { networkInterfaces } from "node:os";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const PORT = Number(process.env.PORT ?? 3000);

serve({ fetch: createApp().fetch, port: PORT, hostname: "0.0.0.0" }, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i?.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  console.log(`Local:  http://localhost:${PORT}`);
  for (const ip of lan) console.log(`Phone:  http://${ip}:${PORT}`);
});
