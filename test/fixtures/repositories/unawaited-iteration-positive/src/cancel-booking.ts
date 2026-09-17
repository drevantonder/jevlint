import { cancelCalendarEvent, findBookings, refundBooking } from "./bookings.js";

export async function cancelBooking(bookingId: string) {
  const bookings = await findBookings(bookingId);
  try {
    bookings.forEach(async (booking) => {
      await refundBooking(booking);
      await cancelCalendarEvent(booking);
    });
  } catch (error) {
    reportFailure(bookingId, error);
  }
}

function reportFailure(bookingId: string, error: unknown): void {
  console.error(bookingId, error);
}
