import { verifyWebhook } from "./verify-webhook.js";

export async function paymentWebhook(request: Request) {
  if (!verifyWebhook(request.rawBody, request.header("x-signature"), webhookSecret)) {
    return new Response("invalid signature", { status: 401 });
  }
  await receivePaymentEvent(await request.json());
  return new Response(null, { status: 202 });
}
