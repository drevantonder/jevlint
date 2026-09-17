export function createApp(): { listen: (port: number) => { close: (done: () => void) => void } } {
  return { listen: (port: number) => ({ close: (done: () => void) => { void port; done(); } }) };
}
