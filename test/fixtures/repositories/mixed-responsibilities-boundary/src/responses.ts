export function created(body: object): Response {
  return Response.json(body, { status: 201 });
}

export function invalidRequest(errors: string[]): Response {
  return Response.json({ errors }, { status: 400 });
}
