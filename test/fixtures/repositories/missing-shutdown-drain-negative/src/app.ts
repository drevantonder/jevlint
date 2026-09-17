export function createApp(): { listen: (port: number) => { close: (done: () => void) => void } } {
  return { listen: (port: number) => ({ close: (done: () => void) => { void port; done(); } }) };
}

export function destroySocket(socket: unknown): void {
  void socket;
}

export function markUnready(): void {}
