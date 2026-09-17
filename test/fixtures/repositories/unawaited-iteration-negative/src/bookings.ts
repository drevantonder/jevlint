export type Booking = { id: string };

export async function findBookings(bookingId: string): Promise<Booking[]> {
  return [{ id: bookingId }];
}

export async function refundBooking(booking: Booking): Promise<void> {
  console.log(booking.id);
}

export async function cancelCalendarEvent(booking: Booking): Promise<void> {
  console.log(booking.id);
}
