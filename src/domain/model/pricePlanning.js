// Deterministic, side-effect-free rule planner. No credentials, model calls,
// approval or writes. Prices/costs are integer minor units; null is not zero.
const amount = value => Number.isSafeInteger(value) && value >= 0;
function productsInput(products) {
  if (!Array.isArray(products) || Array.from(products).some(p => typeof p?.id !== 'string' || !p.id.trim())
    || new Set(products.map(p => p.id)).size !== products.length) throw new TypeError('Unique product IDs required');
}

export function planPrices(products, { minimumMargin = 0.2 } = {}) {
  productsInput(products);
  if (!Number.isFinite(minimumMargin) || minimumMargin < 0 || minimumMargin > 1) throw new TypeError('Invalid margin floor');
  const items = [], excluded = [];
  for (const product of products) {
    // No proposed target is not a proposal to set price to zero.
    if (product.target === null || product.target === undefined) continue;
    let reason = null;
    if (!amount(product.target) || product.target === 0) reason = 'invalid_target';
    else if (!amount(product.price)) reason = 'missing_price';
    else if (!amount(product.cost)) reason = 'missing_cost';
    else if ((product.target - product.cost) / product.target < minimumMargin) reason = 'margin_below_floor';
    else if (product.target === product.price) reason = 'already_at_target';
    if (reason) { excluded.push({ productId: product.id, reason }); continue; }
    items.push({ productId: product.id, name: product.name ?? product.id, before: product.price,
      after: product.target, cost: product.cost, margin: (product.target - product.cost) / product.target });
  }
  return { items, excluded };
}

export function diagnoseProducts(products, options) {
  productsInput(products);
  const plan = planPrices(products, options);
  const missing = products.filter(p => !amount(p.cost));
  const stockouts = products.filter(p => p.stock === 0);
  const priorities = [
    ...missing.map(p => ({ id: 'cost', productId: p.id, title: `补充${p.name ?? p.id}成本`, reason: '成本缺失，不能判断毛利或执行调价' })),
    ...stockouts.map(p => ({ id: 'inventory', productId: p.id, title: `核对${p.name ?? p.id}库存`, reason: '模拟库存为零，补货前还需核对实际库存' })),
    ...plan.items.map(p => ({ id: 'pricing', productId: p.productId, title: `审核${p.name}跟价建议`, reason: '先预览价格与毛利，再确认模拟执行' }))
  ];
  return { missingCostCount: missing.length, stockoutCount: stockouts.length,
    repricingCandidateCount: plan.items.length, priorities,
    dataCoverage: { productCount: products.length, costKnownCount: products.filter(p => amount(p.cost)).length,
      stockKnownCount: products.filter(p => amount(p.stock)).length } };
}

// A planner proposes only data. The caller still creates an immutable preview,
// captures explicit approval, executes via a gateway and verifies readback.
export function createRulePricePlanner() {
  return Object.freeze({ proposePlan: ({ products, minimumMargin = 0.2 }) => planPrices(products, { minimumMargin }) });
}
