export type Pool = { size: number };

let available = 4;

export function configurePool(size: number) {
  available = size;
}

export function acquire(): boolean {
  if (available <= 0) return false;
  available -= 1;
  return true;
}

export function poolSize(): number {
  return available;
}
