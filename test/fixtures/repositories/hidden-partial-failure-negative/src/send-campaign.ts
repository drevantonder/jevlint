import { mailer } from "./mailer.js";

export async function sendCampaign(recipientIds: string[]) {
  const outcomes = await Promise.allSettled(
    recipientIds.map((recipientId) => mailer.send(recipientId)),
  );

  return {
    sent: outcomes
      .filter((outcome) => outcome.status === "fulfilled")
      .map((outcome) => outcome.value),
    failed: outcomes
      .map((outcome, index) => ({ outcome, recipientId: recipientIds[index] }))
      .filter(({ outcome }) => outcome.status === "rejected")
      .map(({ outcome, recipientId }) => ({ recipientId, reason: outcome.reason })),
  };
}
