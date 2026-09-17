export interface Session {
  id: string;
  expiresAt: Date;
}

export function findActiveSession(
  sessions: Session[],
  sessionId: string,
  now: Date,
): Session | null {
  const session = sessions.find((candidate) => candidate.id === sessionId);
  if (!session) return null;
  if (session.expiresAt <= now) return null;
  return session;
}
