export async function publishStripeEvent(event: Stripe.Event) {
  await paymentEvents.publish(event);
}
