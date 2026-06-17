export class BeiClient {
  private baseUrl: string;
  private serviceToken: string;

  constructor(baseUrl: string, serviceToken = "") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.serviceToken = serviceToken;
  }

  private headers() {
    const headers: Record<string, string> = {};
    if (this.serviceToken) {
      headers["x-service-token"] = this.serviceToken;
    }
    return headers;
  }

  private async readJson(res: Response, action: string) {
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error?.message || data?.error || data?.message || `${action} failed: ${res.status} ${res.statusText}`);
    }
    return data;
  }

  async getListedSecurities() {
    const res = await fetch(`${this.baseUrl}/v1/public/securities`, { headers: this.headers() });
    return this.readJson(res, "Fetch securities from BEI");
  }

  async getFeeSchedule() {
    const res = await fetch(`${this.baseUrl}/v1/public/fee-schedule`, { headers: this.headers() });
    return this.readJson(res, "Fetch fee schedule from BEI");
  }
}

export const beiClient = new BeiClient(
  process.env.BEI_API_URL || "http://localhost:4100",
  process.env.BEI_SERVICE_TOKEN || process.env.BEI_SEKURITAS_TOKEN || ""
);
