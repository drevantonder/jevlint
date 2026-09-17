import { getNextAvailableSeat } from "./get-next-available-seat.js";

export function showSeat(flightId: string): string {
  const seat = getNextAvailableSeat(flightId);
  return seat ? `Seat ${seat.id} is available` : "No seats available";
}
