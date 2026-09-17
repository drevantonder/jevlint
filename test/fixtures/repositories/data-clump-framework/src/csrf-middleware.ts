export function verifyCsrf(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  if (!csrf.valid(request)) return response.sendStatus(403);
  next();
}
