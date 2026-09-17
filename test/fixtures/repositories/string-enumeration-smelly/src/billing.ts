export type BillingStatus = "active" | "paused" | "archived";

export type BillingAccount = {
  id: string;
  status: BillingStatus;
  balanceCents: number;
};
