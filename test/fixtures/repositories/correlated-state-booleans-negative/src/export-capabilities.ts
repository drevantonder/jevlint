export interface ExportCapabilities {
  supportsPdf: boolean;
  supportsCsv: boolean;
  supportsJson: boolean;
  supportsEncryption: boolean;
}

export const browserCapabilities: ExportCapabilities = {
  supportsPdf: true,
  supportsCsv: true,
  supportsJson: true,
  supportsEncryption: false,
};
