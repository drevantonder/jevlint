export interface Account {
  id: string;
  plan: "free" | "business" | "enterprise";
  status: "active" | "suspended";
}

export function routeSupport(account: Account): "priority" | "standard" {
  if (account.plan === "enterprise" && account.status === "active") {
    return "priority";
  }
  return "standard";
}
