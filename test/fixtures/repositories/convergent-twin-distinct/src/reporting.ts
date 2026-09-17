export type AuditRecord = {
  actor: string;
  action: string;
  target: string;
  at: string;
  reason: string;
};

export function auditLine(record: AuditRecord): string {
  return `${record.actor} ${record.action} ${record.target}`;
}
