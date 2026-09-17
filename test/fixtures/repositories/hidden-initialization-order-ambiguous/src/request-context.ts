let requestContext: RequestContext | undefined;

export function currentRequestContext(): RequestContext {
  if (!requestContext) throw new Error("No active request context");
  return requestContext;
}

export function runWithRequestContext<T>(
  context: RequestContext,
  task: () => T,
): T {
  const previous = requestContext;
  requestContext = context;
  try {
    return task();
  } finally {
    requestContext = previous;
  }
}
