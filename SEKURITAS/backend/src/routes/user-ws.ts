import { FastifyInstance } from "fastify";
import { authenticateActiveUser } from "../lib/auth.js";
import { registerUserWsClient } from "../services/user-ws-service.js";
import { env } from "../config/env.js";
import jwt from "jsonwebtoken";

export default async function userWsRoutes(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket, request) => {
    // Authenticate WS connection using token query param
    const token = (request.query as any)?.token;
    if (!token) {
      socket.close(1008, "Token required");
      return;
    }

    try {
      const decoded = jwt.verify(token, env.jwtSecret) as any;
      const uid = decoded.user_id || decoded.userId;
      if (!uid) {
        socket.close(1008, "Invalid token");
        return;
      }
      registerUserWsClient(uid, socket);
    } catch (err) {
      socket.close(1008, "Unauthorized");
    }
  });
}
