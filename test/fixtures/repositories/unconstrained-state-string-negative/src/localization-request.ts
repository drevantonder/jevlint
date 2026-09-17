export interface LocalizationRequest {
  locale: string;
  customerName: string;
}

export const browserRequest: LocalizationRequest = {
  locale: navigator.language,
  customerName: "Ada",
};
