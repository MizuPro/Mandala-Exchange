import { createApp } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db/index.js";

const app = await createApp();

const shutdown = async () => {
  await app.close();
  await closeDb();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
