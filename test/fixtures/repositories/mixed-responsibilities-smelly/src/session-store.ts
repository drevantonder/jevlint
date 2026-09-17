export async function deleteExpiredSessions(): Promise<void> {
  await database.sessions.deleteExpired();
}
