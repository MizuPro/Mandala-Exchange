import "dotenv/config";
import { createApp } from "./app.js";

async function start() {
  const app = await createApp();
  
  try {
    const port = Number(process.env.PORT) || 3002;
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`Server listening at http://0.0.0.0:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
