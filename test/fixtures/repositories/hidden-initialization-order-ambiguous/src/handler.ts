import { currentRequestContext, runWithRequestContext } from "./request-context.js";

export function handleRequest(context: RequestContext): Response {
  return runWithRequestContext(context, () => {
    const current = currentRequestContext();
    return routeRequest(current);
  });
}
