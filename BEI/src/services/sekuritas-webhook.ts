import { config } from "../config.js";

type WebhookTarget = "settlement" | "corporate_action";

function targetUrl(target: WebhookTarget) {
  if (target === "settlement") return config.SEKURITAS_SETTLEMENT_WEBHOOK_URL;
  return config.SEKURITAS_CORPORATE_ACTION_WEBHOOK_URL;
}

export async function postSekuritasWebhook(target: WebhookTarget, payload: unknown) {
  const url = targetUrl(target);
  if (!url) {
    if (target === "settlement") {
      throw new Error("SEKURITAS_SETTLEMENT_WEBHOOK_URL is not configured — cannot skip settlement notification");
    }
    return { skipped: true, reason: "webhook_url_not_configured" };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.BEI_TO_SEKURITAS_TOKEN ? { "x-service-token": config.BEI_TO_SEKURITAS_TOKEN } : {})
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Sekuritas ${target} webhook failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`);
  }

  return { skipped: false };
}
