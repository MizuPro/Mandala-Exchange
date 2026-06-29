const baseUrl = process.env.BEI_API_URL || "http://127.0.0.1:4100";
const botToken = "dev-bot-service-token-change-me-2026";
const adminToken = "dev-admin-service-token-change-me-2026";

async function main() {
  const beforeResponse = await fetch(`${baseUrl}/v1/indices/MDX/composition`, { headers: { "x-service-token": botToken } });
  const before: any = await beforeResponse.json();
  if (!beforeResponse.ok || !before.version || !Array.isArray(before.components)) throw new Error(JSON.stringify(before));
  const updateResponse = await fetch(`${baseUrl}/v1/indices/MDX/composition`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-service-token": adminToken },
    body: JSON.stringify({ methodology: before.methodology, components: before.components.map((component: any) => ({ symbol: component.symbol, weight: String(component.weight) })) }),
  });
  const updated: any = await updateResponse.json();
  if (!updateResponse.ok || updated.version !== before.version + 1) throw new Error(JSON.stringify(updated));
  const after: any = await (await fetch(`${baseUrl}/v1/indices/MDX/composition`, { headers: { "x-service-token": botToken } })).json();
  if (after.version !== updated.version || after.components.length !== before.components.length) throw new Error("MDX active composition did not change atomically");
  console.log("MDX VERSIONED COMPOSITION CONTRACT TEST PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
