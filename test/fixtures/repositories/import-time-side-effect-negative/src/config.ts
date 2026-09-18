export type Config = { port: number; host: string };

export const defaults = Object.freeze({ port: 3000, host: "localhost" });

export function formatAddr(config: Config): string {
  return `${config.host}:${config.port}`;
}

export async function start(config: Config = defaults): Promise<string> {
  return formatAddr(config);
}
