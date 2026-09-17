export async function parseRegistrationRequest(request: Request): Promise<
  | { ok: true; value: { email: string } }
  | { ok: false; errors: string[] }
> {
  const body = await request.json();
  return typeof body.email === "string"
    ? { ok: true, value: { email: body.email } }
    : { ok: false, errors: ["email is required"] };
}
