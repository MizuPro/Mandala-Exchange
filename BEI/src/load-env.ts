import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Load the explicitly selected environment file.
 *
 * BEI_SERVICE_TOKENS is a JSON array and production tokens may legitimately
 * contain "#". dotenv treats an unquoted "#" as a comment delimiter, so the
 * raw JSON value is restored from the source line before config validation.
 * New environment files should still quote the complete JSON value.
 */
export function loadEnvironment() {
  const selectedPath = process.env.DOTENV_CONFIG_PATH || ".env";
  const absolutePath = path.resolve(process.cwd(), selectedPath);
  dotenv.config({ path: absolutePath });
  if (!fs.existsSync(absolutePath)) return;

  const line = fs
    .readFileSync(absolutePath, "utf8")
    .split(/\r?\n/)
    .find((value) => value.startsWith("BEI_SERVICE_TOKENS="));
  if (!line) return;

  let rawValue = line.slice("BEI_SERVICE_TOKENS=".length).trim();
  if (
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
    || (rawValue.startsWith('"') && rawValue.endsWith('"'))
  ) {
    rawValue = rawValue.slice(1, -1);
  }
  process.env.BEI_SERVICE_TOKENS = rawValue;
}

loadEnvironment();
