/**
 * Extract the x402 payment payload from the request headers. Three header
 * shapes are accepted, per EVIDIQ-X402-RUNBOOK: `payment-signature`,
 * `Authorization: Payment <base64>`, and `X-PAYMENT`.
 */
export function parsePaymentHeader(
  headers: Record<string, string | string[] | undefined>
): string | null {
  const lower: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    lower[key.toLowerCase()] = value;
  }

  for (const name of ["payment-signature", "x-payment"]) {
    const value = lower[name];
    if (value !== undefined) {
      if (Array.isArray(value)) {
        if (value.length > 0 && typeof value[0] === "string" && value[0] !== "") return value[0];
      } else if (typeof value === "string" && value !== "") {
        return value;
      }
    }
  }

  const auth = lower["authorization"];
  if (auth !== undefined) {
    const candidates = Array.isArray(auth) ? auth : [auth];
    for (const candidate of candidates) {
      if (typeof candidate !== "string") continue;
      const m = /^Payment\s+(.+)$/i.exec(candidate.trim());
      if (m && m[1].trim() !== "") return m[1].trim();
    }
  }

  return null;
}
