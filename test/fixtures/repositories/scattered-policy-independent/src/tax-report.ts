interface CompanyRecord {
  country: string;
  status: string;
}

export function includeInCanadianTaxReport(record: CompanyRecord): boolean {
  if (record.country === "CA" && record.status === "active") return true;
  return false;
}
