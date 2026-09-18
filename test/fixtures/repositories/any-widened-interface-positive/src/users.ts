export interface User {
  id: string;
  name: string;
}

export function formatUser(user: any): any {
  return `${user.id}: ${user.name}`;
}
