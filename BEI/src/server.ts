import { createApp } from "./app.js";
import { config } from "./config.js";
import { closeDb } from "./db/index.js";
import redisClient, { connectRedis } from "./lib/redis.js";

const app = await createApp();
await connectRedis();

const shutdown = async () => {
  await app.close();
  await closeDb();
  await redisClient.quit();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
