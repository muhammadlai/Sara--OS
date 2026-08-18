/**
 * W1 ICP scoring feed — USER.md weights.
 * Only verified research signals raise verified_score.
 * Manual / unverified notes never silently become verified.
 */
export const WEIGHTS = {
  purchase_volume: 0.30,
  product_match: 0.25,
  region: 0.20,
  payment: 0.15,
  authority: 0.10,
};

export function scoreSignals(signals = []) {
  const verified = signals.filter((s) => s && s.verified === true && s.source !== 'manual');
  const all = signals.filter(Boolean);

  const dim = (list, key, fallback = 1) => {
    const hits = list.filter((s) => s.dimension === key || (s.tags || []).includes(key));
    if (!hits.length) return fallback;
    const avg = hits.reduce((n, s) => n + Number(s.value ?? s.weight ?? 1), 0) / hits.length;
    return Math.max(0, Math.min(3, avg));
  };

  function compute(list) {
    const purchase = dim(list, 'purchase_volume', 1);
    const product = dim(list, 'product_match', 1);
    const region = dim(list, 'region', 1);
    const payment = dim(list, 'payment', 1);
    const authority = dim(list, 'authority', 0.5);
    const raw =
      purchase * WEIGHTS.purchase_volume +
      product * WEIGHTS.product_match +
      region * WEIGHTS.region +
      payment * WEIGHTS.payment +
      authority * WEIGHTS.authority;
    return Math.round(Math.min(10, raw * 2.5) * 10) / 10;
  }

  return {
    draft_score: all.length ? compute(all) : null,
    verified_score: verified.length ? compute(verified) : null,
    verified_signal_count: verified.length,
    unverified_signal_count: all.length - verified.length,
  };
}

export function mergeSignals(existing = [], incoming = []) {
  const out = [...existing];
  for (const sig of incoming) {
    const key = `${sig.source || ''}|${sig.url || ''}|${sig.label || sig.text || ''}`;
    const idx = out.findIndex((s) => `${s.source || ''}|${s.url || ''}|${s.label || s.text || ''}` === key);
    if (idx === -1) out.push(sig);
    else out[idx] = { ...out[idx], ...sig };
  }
  return out;
}
