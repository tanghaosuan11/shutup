/** Pure utility helpers — no WASM dependencies, safe to import anywhere */

export function weiToEth(wei: bigint): string {
  const eth = Number(wei) / 1e18;
  if (eth === 0) return "0";
  // Use enough significant digits to represent very small amounts
  if (eth >= 1) return eth.toFixed(4).replace(/\.?0+$/, "");
  if (eth >= 0.0001) return eth.toFixed(6).replace(/\.?0+$/, "");
  if (eth >= 0.0000001) return eth.toFixed(9).replace(/\.?0+$/, "");
  // Fallback: scientific-notation-free fixed precision
  return eth.toFixed(18).replace(/\.?0+$/, "");
}

export function truncHex(hex: string, head = 8, tail = 6): string {
  if (!hex || hex.length <= head + tail + 2) return hex;
  return `${hex.slice(0, head + 2)}...${hex.slice(-tail)}`;
}

/**
 * Format a Unix timestamp (seconds) as a human-readable age string in Chinese.
 * e.g. "3 分钟前", "2 小时前", "5 天前"
 */
export function formatAge(unixSec: number): string {
  const secs = Date.now() / 1000 - unixSec;
  if (secs < 120)    return `${Math.round(secs)} 秒前`;
  if (secs < 7200)   return `${Math.round(secs / 60)} 分钟前`;
  if (secs < 172800) return `${Math.round(secs / 3600)} 小时前`;
  return `${Math.round(secs / 86400)} 天前`;
}

/**
 * Returns a stale-proof warning string, or null if the proof is fresh enough.
 * Thresholds: >7 days → warning, >30 days → strong warning.
 */
export function freshnessWarning(unixSec: number): { level: "warn" | "alert"; msg: string } | null {
  const days = (Date.now() / 1000 - unixSec) / 86400;
  if (days > 30) return { level: "alert", msg: `该证明已超过 30 天，持有者余额可能已大幅变化（${Math.round(days)} 天前的区块）` };
  if (days > 7)  return { level: "warn",  msg: `该证明已超过 7 天（${Math.round(days)} 天前的区块），请酌情接受` };
  return null;
}
