let initialized = false;

export function init(): void {
  initialized = true;
}

// must call init() first
export function run(): string {
  return initialized ? "ready" : "broken";
}
