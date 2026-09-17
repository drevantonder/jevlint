interface ContactRecord {
  country: string;
  status: string;
  acceptsMarketing: boolean;
}

export function canReceiveCanadianCampaign(record: ContactRecord): boolean {
  if (record.country === "CA" && record.status === "active") {
    return record.acceptsMarketing;
  }
  return false;
}
