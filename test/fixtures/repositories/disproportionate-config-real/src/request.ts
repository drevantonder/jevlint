export interface RequestOptions {
  method: "GET" | "POST";
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export function request(url: string, options: RequestOptions) {
  return http.request(url, options);
}
