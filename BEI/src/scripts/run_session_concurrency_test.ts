const baseUrl = process.env.BEI_API_URL || "http://127.0.0.1:4100";
const token = process.env.BEI_SERVICE_TOKEN || "dev-mats-to-bei-token-change-me-2026";
const headers = { "content-type": "application/json", "x-service-token": token };

async function post(path: string, body: unknown) {
  const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const result: any = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(result)}`);
  return result;
}

async function main() {
  const sessionResponse = await fetch(`${baseUrl}/v1/integration/mats/sessions/active`, { headers: { "x-service-token": token } });
  const session: any = await sessionResponse.json();
  if (!sessionResponse.ok || !session.id) throw new Error("Active session template unavailable");
  const virtualDayIndex = Math.floor(Date.now() / 1000);
  const payload = {
    session_template_id: session.id,
    virtual_day_index: virtualDayIndex,
    virtual_duration_seconds: 300,
    real_duration_seconds: 300,
    mats_node_id: "concurrency-test",
  };
  const [first, second] = await Promise.all([
    post("/v1/integration/mats/sessions/instance/activate", payload),
    post("/v1/integration/mats/sessions/instance/activate", payload),
  ]);
  if (first.id !== second.id) throw new Error("Concurrent activation created multiple session instances");
  await post("/v1/integration/mats/sessions/instance/finalize", { instance_id: first.id, version: first.version });
  const finalizedRetry = await post("/v1/integration/mats/sessions/instance/finalize", { instance_id: first.id, version: first.version });
  if (!finalizedRetry.already_finalized) throw new Error("Session finality is not idempotent");
  const next = await post("/v1/integration/mats/sessions/instance/activate", { ...payload, virtual_day_index: virtualDayIndex + 1 });
  if (next.id === first.id || next.virtual_day_index !== virtualDayIndex + 1) throw new Error("Session rollover did not create a new monotonic instance");
  await post("/v1/integration/mats/sessions/instance/finalize", { instance_id: next.id, version: next.version });
  console.log("SESSION CONCURRENCY AND ROLLOVER TEST PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
