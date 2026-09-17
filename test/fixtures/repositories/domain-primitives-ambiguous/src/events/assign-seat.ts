export async function assignSeat(memberId: string, seatId: string) {
  await seating.assign(memberId, seatId);
}
