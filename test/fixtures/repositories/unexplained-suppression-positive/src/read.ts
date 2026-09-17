// @ts-expect-error
export function readId(payload: unknown): string {
  return (payload as { id: string }).id;
}
