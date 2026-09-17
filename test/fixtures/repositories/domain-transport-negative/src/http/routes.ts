import { approveRefundRoute } from "./approve-refund-route.js";

router.post("/refunds/:refundId/approval", approveRefundRoute);
