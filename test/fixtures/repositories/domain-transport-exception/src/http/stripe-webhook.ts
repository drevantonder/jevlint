import type { Request, Response } from "express";
import Stripe from "stripe";
import { publishStripeEvent } from "../payments/publish-stripe-event.js";

const stripe = new Stripe(process.env.STRIPE_API_KEY);

export async function receiveStripeWebhook(request: Request, response: Response) {
  const signature = request.header("stripe-signature");
  try {
    const event = stripe.webhooks.constructEvent(request.body, signature, webhookSecret);
    await publishStripeEvent(event);
    return response.status(202).send();
  } catch {
    return response.status(400).send("invalid webhook signature");
  }
}
