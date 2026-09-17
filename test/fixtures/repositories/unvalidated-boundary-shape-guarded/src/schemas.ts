export const credentialSchema = {
  safeParse: (payload: unknown) => ({ success: true as boolean, data: payload as { token: string } }),
};
