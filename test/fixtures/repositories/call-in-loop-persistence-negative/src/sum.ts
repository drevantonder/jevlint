function double(value: number): number {
  return value * 2;
}

export function sumDoubled(): number {
  let total = 0;
  for (const value of [1, 2, 3]) {
    total += double(value);
  }
  return total;
}
