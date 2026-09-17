export type User = { name: string; score: number };

export function toUsers(names: string[], scores: number[]): User[] {
  const users: User[] = [];
  for (let i = 0; i < names.length; i += 1) {
    users.push({ name: names[i] ?? "", score: scores[i] ?? 0 });
  }
  return users;
}
