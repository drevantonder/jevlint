let server: Server;

export async function startServer(config: ServerConfig): Promise<void> {
  server = await listen(config);
}

export async function stopServer(): Promise<void> {
  await server.close();
}
