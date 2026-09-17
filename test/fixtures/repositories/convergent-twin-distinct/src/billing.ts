export type BillingAccount = {
  id: string;
  status: string;
};

export function accountLabel(account: BillingAccount): string {
  return `${account.id} ${account.status}`;
}
