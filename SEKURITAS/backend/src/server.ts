import "dotenv/config";
import { createApp } from "./app.js";
import { env } from "./config/env.js";

async function start() {
  const app = await createApp();
  
  try {
    const port = env.port;
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`Server listening at http://0.0.0.0:${port} (${env.appEnv}/${env.financeMode})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
