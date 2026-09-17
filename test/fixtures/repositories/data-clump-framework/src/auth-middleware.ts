export function requireAuthentication(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!request.user) return response.sendStatus(401);
  next();
}
