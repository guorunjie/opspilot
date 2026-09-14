const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && value.trim().length > 0;

// Small deterministic rules; absent observations do not create executable plans.
export function planStockout({ productId, stock, warehouseAvailable }) {
  if (!id(productId)) throw new TypeError('Product identity required');
  if (!integer(stock) || !integer(warehouseAvailable)) return { items: [], reason: 'missing_inventory' };
  if (stock !== 0 || warehouseAvailable === 0) return { items: [], reason: 'no_stockout_sync' };
  return { items: [{ targetId: `inventory:${productId}`, before: stock, value: warehouseAvailable }], reason: 'known_stockout_with_available_stock' };
}

export function planCampaign({ productId, campaignPrice, cost, eligible, enrolled, minimumMargin = 0.2 }) {
  if (!id(productId) || !Number.isFinite(minimumMargin) || minimumMargin < 0 || minimumMargin > 1)
    throw new TypeError('Product identity and valid margin required');
  if (!integer(campaignPrice) || campaignPrice === 0 || !integer(cost)) return { items: [], reason: 'missing_price_or_cost' };
  if (eligible !== true || enrolled !== false) return { items: [], reason: 'eligibility_or_enrollment_not_ready' };
  if ((campaignPrice - cost) / campaignPrice < minimumMargin) return { items: [], reason: 'margin_below_floor' };
  return { items: [{ targetId: `campaign:${productId}:offer-${campaignPrice}`, before: 0, value: 1 }], reason: 'eligible_fixed_offer' };
}
