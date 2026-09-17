export interface Seat {
  id: string;
  flightId: string;
  reserved: boolean;
}

const seats: Seat[] = [];

export function findAvailableSeat(flightId: string): Seat | undefined {
  return seats.find((seat) => seat.flightId === flightId && !seat.reserved);
}

export function reserveSeat(flightId: string, seatId: string): void {
  const seat = seats.find((candidate) => candidate.flightId === flightId && candidate.id === seatId);
  if (seat) seat.reserved = true;
}
