import type { Request, Response } from "express";
import { approveRefund } from "../domain/approve-refund.js";

export async function approveRefundRoute(request: Request, response: Response) {
  const decision = await approveRefund({
    refundId: request.params.refundId,
    actorId: request.user.id,
    managerApproved: request.header("x-manager-approved") === "true",
  });

  if (decision.kind === "rejected") {
    return response.status(403).json({ code: decision.reason });
  }
  return response.status(204).send();
}
