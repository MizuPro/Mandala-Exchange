import type { FastifyInstance } from "fastify";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function registerAdminFrontendRoutes(app: FastifyInstance) {
  app.get("/admin", async (request, reply) => {
    const candidates = [
      path.join(__dirname, "../public/admin.html"),
      path.join(process.cwd(), "src/public/admin.html"),
      path.join(process.cwd(), "dist/public/admin.html"),
      path.join(process.cwd(), "public/admin.html")
    ];

    const htmlPath = candidates.find((p) => fs.existsSync(p));

    if (!htmlPath) {
      return reply.status(404).send(
        `Failed to locate admin interface HTML file. Tried paths: \n${candidates.join("\n")}`
      );
    }

    try {
      const htmlContent = fs.readFileSync(htmlPath, "utf8");
      return reply.type("text/html").send(htmlContent);
    } catch (err: any) {
      return reply.status(500).send(`Error reading admin interface: ${err.message}`);
    }
  });
}
