export class AccountNotFoundError extends Error {}
export class PasswordMismatchError extends Error {}

export declare const directory: {
  verify(email: string, password: string): Promise<{ userId: string }>;
};
