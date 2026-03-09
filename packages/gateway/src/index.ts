import { Hono } from "hono";
import { logger } from "hono/logger";
import { config } from "./config.ts";
import { dashboard } from "./dashboard/index.ts";
import { initDb } from "./db.ts";
import { proxy } from "./proxy.ts";

await initDb();

const app = new Hono();

app.use("*", logger());
app.route("/", proxy);
app.route("/dashboard", dashboard);

app.get("/health", (c) => c.json({ status: "ok", version: "0.1.0" }));

console.log(`[CORDON] Gateway listening on port ${config.PORT}`);

export default {
  port: config.PORT,
  fetch: app.fetch,
};
