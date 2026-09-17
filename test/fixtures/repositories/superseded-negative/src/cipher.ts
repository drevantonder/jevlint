/** Local cipher owner: one legacy member, one current member. */
export function createCipheriv(algorithm: string, key: string, iv: string): string {
  return `${algorithm}:${key}:${iv}`;
}

/**
 * Legacy password-based cipher.
 * @deprecated use createCipheriv with an explicit iv instead.
 */
export function createCipher(algorithm: string, password: string): string {
  return `${algorithm}:${password}`;
}
