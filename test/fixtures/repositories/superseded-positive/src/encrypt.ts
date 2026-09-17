import * as crypto from "./cipher.js";

export function encryptSecret(password: string): string {
  return crypto.createCipher("aes192", password);
}
