import { mailer } from "./mailer.js";

export async function sendCampaign(recipientIds: string[]) {
  const outcomes = await Promise.allSettled(
    recipientIds.map((recipientId) => mailer.send(recipientId)),
  );

  return outcomes
    .filter((outcome) => outcome.status === "fulfilled")
    .map((outcome) => outcome.value);
}
