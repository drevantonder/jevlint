export function requireNonNull(value: unknown, field: string): void {
  if (value === null || value === undefined) throw new Error(`missing ${field}`);
}

export function validateGrant(grantType: string, rawTokenId: string): void {
  requireNonNull(grantType, "grantType");
  requireNonNull(rawTokenId, "rawTokenId");
}
