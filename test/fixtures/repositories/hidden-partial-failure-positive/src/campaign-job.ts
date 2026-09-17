import { sendCampaign } from "./send-campaign.js";

export async function runCampaignJob(recipientIds: string[]) {
  const sentMessages = await sendCampaign(recipientIds);
  return { status: "complete" as const, sentCount: sentMessages.length };
}
