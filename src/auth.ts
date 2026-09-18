export const ENV_VAR_NAME = "TYPESAFE_API_KEY";

export type CredentialSource = "env";

export interface ResolvedCredential {
  token: string;
  source: CredentialSource;
}

export const MISSING_CREDENTIAL_MESSAGE =
  `jevlint: no Typesafe API key found. Set ${ENV_VAR_NAME}.`;

export function authRejectionMessage(source: string): string {
  return `Typesafe rejected the API key (${source}). Set ${ENV_VAR_NAME} to a new key.`;
}

export class CredentialRejectedError extends Error {
  readonly source: string;

  constructor(source: string) {
    super(authRejectionMessage(source));
    this.name = "CredentialRejectedError";
    this.source = source;
  }
}

export function isAuthFailure(error: Error): boolean {
  if (error.name === "AuthenticationError" || error.name === "PermissionDeniedError") return true;
  if ("status" in error) {
    const status = error.status;
    if (status === 401 || status === 403) return true;
  }
  return false;
}

function cleanToken(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface AuthIO {
  env: NodeJS.ProcessEnv;
}

export function defaultAuthIO(): AuthIO {
  return { env: process.env };
}

export function resolveCredentialWithIO(io: AuthIO): ResolvedCredential | undefined {
  const token = cleanToken(io.env[ENV_VAR_NAME]);
  if (token === undefined) return undefined;
  return { token, source: "env" };
}

export function resolveCredential(): ResolvedCredential | undefined {
  return resolveCredentialWithIO(defaultAuthIO());
}
