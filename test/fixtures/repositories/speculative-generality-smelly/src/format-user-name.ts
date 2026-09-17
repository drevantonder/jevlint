export interface FormatOptions {
  separator?: string;
  transformPart?: (value: string, index: number) => string;
  beforeFormat?: (user: User) => void;
  afterFormat?: (result: string) => string;
}

export function formatUserName(user: User, options: FormatOptions = {}): string {
  options.beforeFormat?.(user);
  const separator = options.separator ?? " ";
  const parts = [user.firstName, user.lastName].map(
    (part, index) => options.transformPart?.(part, index) ?? part,
  );
  const result = parts.join(separator).trim();
  return options.afterFormat?.(result) ?? result;
}
