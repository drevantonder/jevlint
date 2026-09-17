export type UserRecord = {
  id: string;
  name: string;
  email: string;
  role: string;
  createdAt: string;
  lastLoginAt: string;
};

export function serializeUser(user: UserRecord): string {
  return JSON.stringify({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  });
}

export function parseUser(payload: string): UserRecord {
  const data = JSON.parse(payload) as Partial<UserRecord>;
  return {
    id: data.id ?? "",
    name: data.name ?? "",
    email: data.email ?? "",
    role: data.role ?? "member",
    createdAt: "",
    lastLoginAt: "",
  };
}
