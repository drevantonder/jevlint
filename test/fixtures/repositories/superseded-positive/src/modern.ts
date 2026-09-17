import * as crypto from "./cipher.js";

export function encryptModern(key: string, iv: string): string {
  return crypto.createCipheriv("aes-256-gcm", key, iv);
}
