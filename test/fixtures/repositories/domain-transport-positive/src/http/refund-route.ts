import { approveRefund } from "../domain/approve-refund.js";

export async function refundRoute(request: Request) {
  return sendHttpResult(await approveRefund(request));
}
