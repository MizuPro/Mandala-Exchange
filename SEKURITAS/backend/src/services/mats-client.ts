import fetch from "node-fetch"; // Assuming using native fetch or node-fetch

export class MatsClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async placeOrder(orderPayload: any) {
    const res = await fetch(`${this.baseUrl}/api/v1/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderPayload),
    });
    if (!res.ok) {
      throw new Error(`MATS Place Order Failed: ${res.statusText}`);
    }
    return res.json();
  }

  async amendOrder(matsOrderId: string, amendPayload: any) {
    const res = await fetch(`${this.baseUrl}/api/v1/orders/${matsOrderId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(amendPayload),
    });
    if (!res.ok) {
      throw new Error(`MATS Amend Order Failed: ${res.statusText}`);
    }
    return res.json();
  }

  async cancelOrder(matsOrderId: string) {
    const res = await fetch(`${this.baseUrl}/api/v1/orders/${matsOrderId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      throw new Error(`MATS Cancel Order Failed: ${res.statusText}`);
    }
    return res.json();
  }
}

export const matsClient = new MatsClient(process.env.MATS_API_URL || "http://localhost:3000");
