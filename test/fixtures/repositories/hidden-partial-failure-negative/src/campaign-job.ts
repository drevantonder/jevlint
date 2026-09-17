import { sendCampaign } from "./send-campaign.js";

export async function runCampaignJob(recipientIds: string[]) {
  const result = await sendCampaign(recipientIds);
  if (result.failed.length > 0) {
    return { status: "partial" as const, ...result };
  }
  return { status: "complete" as const, ...result };
}
