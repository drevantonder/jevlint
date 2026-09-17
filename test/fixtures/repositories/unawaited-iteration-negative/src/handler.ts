import { cancelBooking } from "./cancel-booking.js";

export async function handleCancellation(bookingId: string) {
  await cancelBooking(bookingId);
  return { cancelled: bookingId };
}
