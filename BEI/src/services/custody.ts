import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { brokerMembers, custodyAccounts } from "../db/schema.js";

function reference(prefix: string, brokerCode: string, investorId: string) {
  const normalized = `${brokerCode}-${investorId}`.replace(/[^A-Z0-9-]/gi, "").toUpperCase();
  return `${prefix}-${normalized}`;
}

export async function ensureCustodyAccount(input: {
  brokerId: string;
  brokerCode: string;
  investorId: string;
}) {
  const existing = await db
    .select()
    .from(custodyAccounts)
    .where(eq(custodyAccounts.investorId, input.investorId));
  const byBroker = existing.find((account) => account.brokerId === input.brokerId);
  if (byBroker) return byBroker;

  const [created] = await db
    .insert(custodyAccounts)
    .values({
      brokerId: input.brokerId,
      investorId: input.investorId,
      sid: reference("SID", input.brokerCode, input.investorId),
      sre: reference("SRE", input.brokerCode, input.investorId),
      rdn: reference("RDN", input.brokerCode, input.investorId)
    })
    .returning();

  if (!created) throw new Error("Failed to create custody account");
  return created;
}

export async function findBrokerByCode(code: string) {
  const [broker] = await db
    .select()
    .from(brokerMembers)
    .where(eq(brokerMembers.code, code.toUpperCase()));
  return broker;
}
