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

  private async get(path: string, action: string) {
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    return this.readJson(res, action);
  }

  async getListedSecurities() {
    return this.get("/v1/public/securities", "Fetch securities from BEI");
  }

  async getFeeSchedule() {
    return this.get("/v1/public/fee-schedule", "Fetch fee schedule from BEI");
  }

  async getSecurity(symbol: string) {
    return this.get(`/v1/public/securities/${encodeURIComponent(symbol.toUpperCase())}`, "Fetch security detail from BEI");
  }

  async getFundamentals(symbol: string) {
    return this.get(`/v1/public/securities/${encodeURIComponent(symbol.toUpperCase())}/fundamentals`, "Fetch fundamentals from BEI");
  }

  async getCorporateActions() {
    return this.get("/v1/reports/corporate-actions", "Fetch corporate actions from BEI");
  }

  async getIpoEvents() {
    return this.get("/v1/ipo-events", "Fetch IPO events from BEI");
  }

  async getAnnouncements(symbol: string) {
    const security = await this.getSecurity(symbol);
    const issuerId = security?.issuer_id || security?.issuerId;
    if (!issuerId) return [];
    return this.get(`/v1/issuers/${encodeURIComponent(issuerId)}/announcements`, "Fetch issuer announcements from BEI");
  }

  async getSettlementSession(sessionId: string) {
    return this.get(`/v1/settlement/session/${encodeURIComponent(sessionId)}`, "Fetch settlement session from BEI");
  }

  async getCustodySummary(brokerCode: string, investorId: string) {
    return this.get(
      `/v1/custody/accounts/${encodeURIComponent(brokerCode)}/${encodeURIComponent(investorId)}/summary`,
      "Fetch custody summary from BEI"
    );
  }

  async getReconciliation(brokerCode: string, investorId: string) {
    return this.get(
      `/v1/reconciliation/${encodeURIComponent(brokerCode)}/${encodeURIComponent(investorId)}`,
      "Fetch reconciliation from BEI"
    );
  }

  async getTradesReport(sessionId: string) {
    return this.get(`/v1/reports/trades/${encodeURIComponent(sessionId)}`, "Fetch trades report from BEI");
  }

  async getSettlementsReport(sessionId: string) {
    return this.get(`/v1/reports/settlements/${encodeURIComponent(sessionId)}`, "Fetch settlements report from BEI");
  }

  async getMarketSummaryReport(sessionId: string) {
    return this.get(`/v1/reports/market-summary/${encodeURIComponent(sessionId)}`, "Fetch market summary from BEI");
  }
}

export const beiClient = new BeiClient(
  process.env.BEI_API_URL || "http://localhost:4100",
  process.env.BEI_SERVICE_TOKEN || process.env.BEI_SEKURITAS_TOKEN || ""
);
