export interface Trial {
  accountId: string;
  startsAt: Date;
  status: "active";
}

export function createTrial(accountId: string): Trial {
  return {
    accountId,
    startsAt: new Date(),
    status: "active",
  };
}
