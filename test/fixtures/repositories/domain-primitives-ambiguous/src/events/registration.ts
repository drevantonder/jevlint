import { assignSeat } from "./assign-seat.js";

export async function registerAttendee(registration: Registration) {
  await assignSeat(registration.memberId, registration.requestedSeatId);
}
