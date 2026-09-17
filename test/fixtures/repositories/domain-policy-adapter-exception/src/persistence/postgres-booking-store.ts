import { DatabaseError } from "pg";
import { BookingAlreadyExists } from "../domain/booking-errors.js";

export async function insertBooking(booking: Booking): Promise<void> {
  try {
    await database.query("insert into bookings values ($1, $2)", [booking.id, booking.roomId]);
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "23505") {
      throw new BookingAlreadyExists(booking.id);
    }
    throw error;
  }
}
