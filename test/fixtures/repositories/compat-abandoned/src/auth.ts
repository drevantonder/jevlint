export function authenticate(token: string): boolean {
  return token.trim().length >= 8;
}
