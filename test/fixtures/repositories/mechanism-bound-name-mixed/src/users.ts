export interface DirectoryUser {
  id: string;
  email: string;
}

export function findUserByLoop(users: DirectoryUser[], id: string): DirectoryUser | undefined {
  for (let index = 0; index < users.length; index += 1) {
    if (users[index]?.id === id) return users[index];
  }
  return undefined;
}

export function parseWithRegex(source: string): string[] {
  const pattern = /[A-Za-z]+/g;
  return source.match(pattern) ?? [];
}

export function findUser(users: DirectoryUser[], id: string): DirectoryUser | undefined {
  return users.find((user) => user.id === id);
}

export function hashPassword(password: string): string {
  let hash = 0;
  for (let index = 0; index < password.length; index += 1) {
    hash = (hash * 31 + password.charCodeAt(index)) | 0;
  }
  return String(hash);
}
