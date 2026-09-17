import { findAvailableSeat, reserveSeat } from "./seat-store.js";
import type { Seat } from "./seat-store.js";

export function getNextAvailableSeat(flightId: string): Seat | null {
  const seat = findAvailableSeat(flightId);
  if (!seat) return null;
  reserveSeat(flightId, seat.id);
  return seat;
}
