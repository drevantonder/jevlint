export interface Seat {
  id: string;
  flightId: string;
  reserved: boolean;
}

declare const seats: Seat[];

export function getNextAvailableSeat(flightId: string): Seat | null {
  return seats.find((seat) => seat.flightId === flightId && !seat.reserved) ?? null;
}
