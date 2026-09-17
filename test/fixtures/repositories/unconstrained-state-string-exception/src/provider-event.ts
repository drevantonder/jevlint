export interface ProviderEvent {
  eventType: string;
  payload: Record<string, unknown>;
}

export function decodeProviderEvent(body: string): ProviderEvent {
  return JSON.parse(body) as ProviderEvent;
}
