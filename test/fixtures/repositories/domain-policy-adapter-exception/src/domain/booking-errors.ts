export class BookingAlreadyExists extends Error {
  constructor(readonly bookingId: string) {
    super(`Booking ${bookingId} already exists`);
  }
}
