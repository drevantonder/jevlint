export function total(values: number[]): number {
  let running = 0;
  for (let i = 0; i < values.length; i += 1) {
    running += values[i] ?? 0;
  }
  return running;
}

export function first(values: string[]): string {
  try {
    const found = values.at(0);
    if (found === undefined) throw new Error("empty");
    return found;
  } catch (e) {
    throw e;
  }
}

export function describe(value: string): string {
  return [value].map((item) => item.trim()).join(",");
}
