const CURRENCY_SYMBOLS: [RegExp, string][] = [
  [/₹|\bRs\.?|\bINR\b/i, "INR"],
  [/US\$|\$|\bUSD\b/, "USD"],
  [/€|\bEUR\b/, "EUR"],
  [/£|\bGBP\b/, "GBP"],
  [/¥|\bJPY\b/, "JPY"],
  [/\bAED\b|د\.إ/, "AED"],
];

export const PRICE_PATTERN = /(?:₹|Rs\.?|INR|US\$|\$|€|£|¥|AED|USD|EUR|GBP)\s?\d[\d,.\s]*\d|\d[\d,.]*\d\s?(?:₹|€|£|INR|USD|EUR|GBP)/i;

/**
 * Turns "₹1,29,999.00", "$1,299.99", "1.299,00 €" or "Rs. 499" into a number.
 * Returns null when the text has no price-like number.
 */
export function parsePrice(text: string | null | undefined): { value: number; currency: string | null } | null {
  if (!text) return null;
  const match = /\d[\d.,\s ]*/.exec(text.replace(/‎/g, ""));
  if (!match) return null;
  let num = match[0].replace(/[\s ]/g, "").replace(/[.,]$/, "");
  const lastComma = num.lastIndexOf(",");
  const lastDot = num.lastIndexOf(".");
  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal point.
    num = lastComma > lastDot ? num.replace(/\./g, "").replace(",", ".") : num.replace(/,/g, "");
  } else if (lastComma > -1) {
    const decimals = num.length - lastComma - 1;
    const commas = (num.match(/,/g) ?? []).length;
    num = commas === 1 && decimals === 2 ? num.replace(",", ".") : num.replace(/,/g, "");
  } else if (lastDot > -1) {
    const decimals = num.length - lastDot - 1;
    const dots = (num.match(/\./g) ?? []).length;
    if (dots > 1 || decimals === 3) num = num.replace(/\./g, "");
  }
  const value = Number(num);
  if (!Number.isFinite(value) || value <= 0) return null;
  const currency = CURRENCY_SYMBOLS.find(([re]) => re.test(text))?.[1] ?? null;
  return { value, currency };
}

export function discountPercent(price: number | null | undefined, listPrice: number | null | undefined): number | null {
  if (!price || !listPrice || listPrice <= price) return null;
  return Math.round(((listPrice - price) / listPrice) * 1000) / 10;
}
