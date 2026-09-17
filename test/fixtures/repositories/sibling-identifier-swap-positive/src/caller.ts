import { validateGrant } from "./token.js";

export function handleGrant(grantType: string, rawTokenId: string): void {
  validateGrant(grantType, rawTokenId);
}
