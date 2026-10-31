/** Indian digit grouping: 125000 -> 1,25,000 */
export function indianGroup(n: number): string {
  const [intPart, frac] = Math.abs(n).toString().split('.');
  let s = intPart!;
  if (s.length > 3) {
    const last3 = s.slice(-3);
    const rest = s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    s = `${rest},${last3}`;
  }
  return (n < 0 ? '-' : '') + s + (frac ? `.${frac}` : '');
}

export function formatRs(n: number): string {
  return `Rs. ${indianGroup(n)}`;
}

/** Normalises any "₹ 18500", "Rs 18,500", "INR18500" mention to "Rs. 18,500". */
export function normalisePrices(text: string): string {
  return text.replace(/(?:₹|\bRs\.?|\bINR)\s*(\d(?:[\d,]*\d)?(?:\.\d+)?)/gi, (_m, num: string) => {
    const n = Number(num.replace(/,/g, ''));
    return Number.isFinite(n) ? formatRs(n) : _m;
  });
}
