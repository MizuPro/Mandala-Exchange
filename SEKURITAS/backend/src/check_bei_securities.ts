import { beiClient } from "./services/bei-client.js";
import pg from "pg";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("Checking listed securities from BEI...");
  
  // Method 1: Try via BEI API Client
  try {
    console.log("Attempting to fetch via BEI API...");
    const securities = await beiClient.getListedSecurities();
    console.log("Securities from API:", JSON.stringify(securities, null, 2));
    process.exit(0);
  } catch (err: any) {
    console.log("BEI API is not accessible or offline:", err.message);
  }

  // Method 2: Try direct connection to BEI Database
  try {
    console.log("Attempting direct connection to BEI database...");
    const { Pool } = pg;
    const pool = new Pool({ connectionString: "postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei" });
    const res = await pool.query("SELECT symbol, name FROM listed_securities WHERE status = 'listed'");
    console.log("Securities from DB:", JSON.stringify(res.rows, null, 2));
    await pool.end();
    process.exit(0);
  } catch (err: any) {
    console.log("Failed to connect to BEI Database:", err.message);
  }

  console.log("Using hardcoded fallback (MNDL, NUSA, BARA) based on seed file.");
  process.exit(0);
}

main().catch(err => {
  console.error("Error:", err);
  process.exit(1);
});
