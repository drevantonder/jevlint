export function traceRequest(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  response.setHeader("trace-id", request.traceId);
  next();
}
