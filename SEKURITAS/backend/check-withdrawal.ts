import { beiClient } from "./src/services/bei-client.js";
import { env } from "./src/config/env.js";

async function run() {
  console.log("=== BEI CLIENT DIAGNOSTIC ===");
  console.log("BEI API URL:", env.beiApiUrl);
  console.log("BEI Service Token:", env.beiServiceToken ? "Available" : "Missing");
  
  try {
    const res = await beiClient.getCustodySummary(env.brokerCode || "MANDALA", "ca867e2f-43ea-4462-9f31-67b932f451c5");
    console.log("Custody Summary Response:", res);
  } catch (err: any) {
    console.error("Error fetching custody summary from BEI:");
    console.error("Message:", err.message);
    if (err.cause) console.error("Cause:", err.cause);
  }
  process.exit(0);
}

run();
