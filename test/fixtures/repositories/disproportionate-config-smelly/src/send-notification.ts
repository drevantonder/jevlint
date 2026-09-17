export interface NotificationOptions {
  channel?: "email" | "sms" | "push";
  urgent?: boolean;
  retryCount?: number;
  retryDelayMs?: number;
  subjectPrefix?: string;
  transformBody?: (body: string) => string;
  beforeSend?: () => void;
  afterSend?: () => void;
}

export function sendNotification(message: string, options: NotificationOptions = {}) {
  options.beforeSend?.();
  const body = options.transformBody?.(message) ?? message;
  transport.send(options.channel ?? "email", `${options.subjectPrefix ?? ""}${body}`);
  options.afterSend?.();
}
