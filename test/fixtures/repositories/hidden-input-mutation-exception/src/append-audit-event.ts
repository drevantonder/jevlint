export interface AuditEvent {
  occurredAt: Date;
  message: string;
}

export function appendAuditEventInPlace(events: AuditEvent[], event: AuditEvent): void {
  events.push(event);
}
