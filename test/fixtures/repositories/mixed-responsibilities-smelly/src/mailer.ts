export async function sendFinanceDigest(html: string): Promise<void> {
  await mailer.send({ to: "finance@example.com", html });
}
