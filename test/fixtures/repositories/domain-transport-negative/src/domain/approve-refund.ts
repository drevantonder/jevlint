export async function approveRefund(command: ApproveRefund): Promise<RefundDecision> {
  const refund = await refundStore.find(command.refundId);
  if (refund.requestedCents > 50_000 && !command.managerApproved) {
    return { kind: "rejected", reason: "manager-approval-required" };
  }
  refund.approve(command.actorId);
  await refundStore.save(refund);
  return { kind: "approved" };
}
