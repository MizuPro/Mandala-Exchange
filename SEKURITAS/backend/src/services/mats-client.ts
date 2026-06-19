import fetch from "node-fetch";
import { env } from "../config/env.js";

export class MatsClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly statusText: string
  ) {
    super(message);
  }
}

export class MatsClient {
  private baseUrl: string;
  private serviceToken: string;

  constructor(baseUrl: string, serviceToken = "") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.serviceToken = serviceToken;
  }

  private headers(extra: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extra };
    if (this.serviceToken) {
      headers["x-service-token"] = this.serviceToken;
    }
    return headers;
  }

  private async parseError(res: any, action: string) {
    const data = await res.json().catch(() => null);
    throw new MatsClientError(
      data?.error || data?.message || `MATS ${action} failed: ${res.status} ${res.statusText}`,
      res.status,
      res.statusText
    );
  }

  async placeOrder(orderPayload: any) {
    const idempotencyKey = orderPayload.idempotency_key;
    const res = await fetch(`${this.baseUrl}/v1/orders`, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      }),
      body: JSON.stringify(orderPayload),
    });
    if (!res.ok) {
      await this.parseError(res, "place order");
    }
    return res.json();
  }

  async amendOrder(matsOrderId: string, amendPayload: any) {
    const idempotencyKey = amendPayload.idempotency_key;
    const res = await fetch(`${this.baseUrl}/v1/orders/${matsOrderId}`, {
      method: "PATCH",
      headers: this.headers({
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      }),
      body: JSON.stringify(amendPayload),
    });
    if (!res.ok) {
      await this.parseError(res, "amend order");
    }
    return res.json();
  }

  async cancelOrder(matsOrderId: string, idempotencyKey: string) {
    const res = await fetch(`${this.baseUrl}/v1/orders/${matsOrderId}/cancel`, {
      method: "POST",
      headers: this.headers({
        "Content-Type": "application/json",
        "idempotency-key": idempotencyKey,
      }),
      body: JSON.stringify({ idempotency_key: idempotencyKey }),
    });
    if (!res.ok) {
      await this.parseError(res, "cancel order");
    }
    return res.json();
  }
}

export const matsClient = new MatsClient(
  env.matsApiUrl,
  env.matsServiceToken || process.env.MATS_SEKURITAS_TOKEN || ""
);
