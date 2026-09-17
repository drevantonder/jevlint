import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_API_KEY);

export async function chargeCustomer(charge: ChargeRequest): Promise<ChargeResult> {
  if (charge.customer.accountAgeDays < 30 && charge.amountCents > 50_000) {
    return { kind: "declined", reason: "new-account-limit" };
  }

  const intent = await stripe.paymentIntents.create({
    amount: charge.amountCents,
    currency: charge.currency,
    customer: charge.customer.paymentProfileId,
  });
  return { kind: "charged", paymentId: intent.id };
}
