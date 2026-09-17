import type { LocalizationRequest } from "./localization-request.js";

export function greeting(request: LocalizationRequest): string {
  if (request.locale === "en-GB") return `Hello ${request.customerName}`;
  if (request.locale === "fr-FR") return `Bonjour ${request.customerName}`;
  return new Intl.DisplayNames([request.locale], { type: "language" }).of(request.locale) ?? request.customerName;
}
