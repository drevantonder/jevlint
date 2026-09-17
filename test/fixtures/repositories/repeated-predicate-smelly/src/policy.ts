export type User = { role: string; team: string };

export function describeAccess(user: User): string {
  const parts: string[] = [];
  if (user.role === "admin") parts.push("console");
  if (user.team === "core") parts.push("repo");
  if (user.role === "admin") parts.push("audit");
  if (user.role === "admin" && user.team === "core") parts.push("deploy");
  if (user.role === "admin") parts.push("billing");
  return parts.join(",");
}
