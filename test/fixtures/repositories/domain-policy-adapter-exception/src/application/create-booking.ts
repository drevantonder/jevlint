import { insertBooking } from "../persistence/postgres-booking-store.js";

export async function createBooking(booking: Booking) {
  await insertBooking(booking);
}
