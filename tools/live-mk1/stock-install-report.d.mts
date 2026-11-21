export const STOCK_INSTALL_PROBE: string;
export type StockInstallFacts = {
  compatible: string;
  model: string;
  board: string;
  soc: string;
  mpcOsVersion: string;
  rootfsPartition: string;
  capacityBytes: number;
  serialSha256: string;
  serialHashes: string[];
  deviceTreeSerial: string;
  filesystem: string;
  rootDevice: string;
  source: string;
};
export function parseStockInstallReport(text: string): StockInstallFacts;
export function stockInstallReceipt(
  report: string,
  options?: { collectedAt?: string },
): {
  format: string;
  version: number;
  method: string;
  expectedBootloader: string;
  collectedAt: string;
  report: { file: string; sha256: string };
};
