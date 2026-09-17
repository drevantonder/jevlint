export const RATE_LIMIT = "ERR_RATE_V2";

export function limitError(): Error {
  return new Error("ERR_RATE_V2");
}
