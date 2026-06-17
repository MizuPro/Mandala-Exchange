import { Redis } from "ioredis";
import { config } from "../config.js";

const redisClient = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
});

redisClient.on("error", (error: any) => {
  console.error("[Redis] Error:", error);
});

redisClient.on("connect", () => {
  console.log("[Redis] Connected to", config.REDIS_URL);
});

export async function connectRedis() {
  if (redisClient.status === "wait" || redisClient.status === "end") {
    await redisClient.connect();
  }
}

export async function publishMarketUpdate(eventType: string, payload: any) {
  try {
    if (redisClient.status !== "ready") return;
    const message = JSON.stringify({
      type: eventType,
      timestamp: new Date().toISOString(),
      payload: JSON.stringify(payload)
    });
    await redisClient.publish("market_updates", message);
    console.log(`[Redis] Published market update event: ${eventType}`);
  } catch (error) {
    console.error(`[Redis] Failed to publish market update event: ${eventType}`, error);
  }
}

export default redisClient;
