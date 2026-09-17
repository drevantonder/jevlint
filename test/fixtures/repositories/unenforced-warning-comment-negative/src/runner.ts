let initialized = false;

export function init(): void {
  initialized = true;
}

// must call init() first
export function run(): string {
  if (!initialized) {
    throw new Error("runner used before init");
  }
  return "ready";
}
