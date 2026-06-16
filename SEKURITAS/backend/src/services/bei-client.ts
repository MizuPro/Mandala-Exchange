export class BeiClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async getListedSecurities() {
    const res = await fetch(`${this.baseUrl}/api/v1/issuers/securities`);
    if (!res.ok) throw new Error("Failed to fetch securities from BEI");
    return res.json();
  }

  async getFeeSchedule() {
    const res = await fetch(`${this.baseUrl}/api/v1/rules/fees`);
    if (!res.ok) throw new Error("Failed to fetch fee schedule from BEI");
    return res.json();
  }
}

export const beiClient = new BeiClient(process.env.BEI_API_URL || "http://localhost:3001");
