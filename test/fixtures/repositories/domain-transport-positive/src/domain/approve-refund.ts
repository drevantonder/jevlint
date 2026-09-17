import type { Request } from "express";
import { refundStore } from "../persistence/refund-store.js";

export async function approveRefund(request: Request) {
  const refund = await refundStore.find(request.params.refundId);
  const managerApproved = request.header("x-manager-approved") === "true";

  if (refund.requestedCents > 50_000 && !managerApproved) {
    return { status: 403, body: { code: "manager-approval-required" } };
  }

  refund.approve(request.user.id);
  await refundStore.save(refund);
  return { status: 204, body: null };
}
