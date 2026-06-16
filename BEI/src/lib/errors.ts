import type { FastifyReply } from "fastify";
import { ZodError } from "zod";

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
  }
}

export function notFound(message = "Resource not found") {
  return new AppError(404, message);
}

export function badRequest(message: string, details?: unknown) {
  return new AppError(400, message, details);
}

export function conflict(message: string, details?: unknown) {
  return new AppError(409, message, details);
}

export function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.status(400).send({
      error: "ValidationError",
      message: "Invalid request payload",
      details: error.flatten()
    });
  }

  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      error: "AppError",
      message: error.message,
      details: error.details
    });
  }

  throw error;
}
