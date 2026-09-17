export type User = { role: string; team: string };

export function describeAccess(user: User): string {
  const isAdmin = user.role === "admin";
  const parts: string[] = [];
  if (isAdmin) parts.push("console");
  if (user.team === "core") parts.push("repo");
  if (isAdmin) parts.push("audit");
  return parts.join(",");
}
