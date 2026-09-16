// src/domain/model/sourceOpportunities.js
// DS038 — Source opportunities (DS040 campaign extension).
//
// Derives advisory, non-executable proposals from a normalized source
// observation. No I/O, no authority, no execution: every opportunity carries
// requiresApproval: true and executable: false.
//
// DS040 adds a 'campaign' opportunity kind, planned by planCampaign() from
// operationPlanning.js. Campaign opportunities are emitted only for products
// that name a known campaign id, carry a known campaignPrice and cost, and
// whose booleans are *explicitly* true eligibility and *explicitly* false
// enrollment. A missing/null boolean is never treated as false, so a product
// with absent flags yields no campaign proposal.

import { createHash } from 'node:crypto';
import { normalizeSourceObservation } from './sourceObservation.js';
import { planPrices } from './pricePlanning.js';
import { planStockout, planCampaign } from './operationPlanning.js';

const ALLOWED = ['expectedScope', 'now', 'maxAgeMs', 'minimumMargin'];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
}

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

function validateOptions(options) {
  const o = options === undefined ? {} : options;
  if (!isPlainObject(o)) throw new TypeError('options must be a plain object');
  for (const k of Reflect.ownKeys(o)) {
    if (typeof k === 'symbol') throw new TypeError('options must not use symbol keys');
    if (!ALLOWED.includes(k)) throw new TypeError(`unknown option: ${String(k)}`);
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !('value' in d)) throw new TypeError(`option ${k} must be a data property`);
    if (d.get || d.set) throw new TypeError(`option ${k} must not be an accessor`);
    if (!d.enumerable) throw new TypeError(`option ${k} must be enumerable`);
  }
  const { expectedScope, now, maxAgeMs, minimumMargin } = o;
  if (minimumMargin !== undefined) {
    if (typeof minimumMargin !== 'number' || !Number.isFinite(minimumMargin)) {
      throw new TypeError('minimumMargin must be a finite number');
    }
    if (minimumMargin < 0 || minimumMargin > 1) {
      throw new RangeError('minimumMargin must be within 0..1');
    }
  }
  return { expectedScope, now, maxAgeMs, minimumMargin };
}

function makeId(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function observationIdentity(normalized) {
  const m = normalized;
  return {
    observationId: m.observationId,
    sourceId: m.sourceId,
    mode: m.mode,
    platformId: m.platformId,
    storeId: m.storeId,
    observedAt: m.observedAt,
  };
}

/**
 * Identity hash parts. Every kind hashes exactly as before; only 'campaign'
 * appends the campaignId, so distinct campaigns on the same product get
 * distinct ids while pricing/inventory/data_quality hashes are untouched.
 */
function identityParts({ identity, productId, kind, campaignId }) {
  const parts = [
    identity.observationId,
    identity.sourceId,
    identity.mode,
    identity.platformId,
    identity.storeId,
    productId,
    kind,
  ];
  if (kind === 'campaign') parts.push(campaignId ?? null);
  return parts;
}

function buildOpportunity({ identity, productId, kind, proposal, campaignId }) {
  const { observationId, sourceId, mode, platformId, storeId, observedAt } = identity;
  return {
    id: makeId(identityParts({ identity, productId, kind, campaignId })),
    kind,
    productId,
    source: { observationId, sourceId, mode, platformId, storeId, observedAt },
    proposal: proposal ?? null,
    requiresApproval: true,
    executable: false,
  };
}

/** Explicit true only: a missing/null/absent flag is never upgraded to true. */
function isExplicitlyTrue(v) {
  return v === true;
}

/** Explicit false only: a missing/null/absent flag is never downgraded to false. */
function isExplicitlyFalse(v) {
  return v === false;
}

export function buildSourceOpportunities(input, options) {
  const cfg = validateOptions(options);

  const normalized = normalizeSourceObservation(input, {
    expectedScope: cfg.expectedScope,
    now: cfg.now,
    maxAgeMs: cfg.maxAgeMs,
  });

  if (normalized.status !== 'READY') {
    // Unknown/foreign/stale snapshots yield no proposals of any kind.
    return deepFreeze({ observation: normalized, opportunities: [], excluded: [] });
  }

  const products = normalized.products ?? [];
  const identity = observationIdentity(normalized);
  const minimumMargin = cfg.minimumMargin === undefined ? 0.2 : cfg.minimumMargin;

  const priced = planPrices(
    products.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      cost: p.cost,
      target: p.referencePrice,
    })),
    { minimumMargin },
  );

  const opportunities = [];
  const excluded = [];

  for (const item of priced.items) {
    opportunities.push(
      buildOpportunity({
        identity,
        productId: item.productId,
        kind: 'pricing',
        proposal: {
          before: item.before,
          after: item.after,
          cost: item.cost,
          margin: item.margin,
        },
      }),
    );
  }

  for (const item of priced.excluded) {
    excluded.push({ productId: item.productId, reason: item.reason });
  }

  for (const product of products) {
    if (product.cost === null || product.cost === undefined) {
      opportunities.push(
        buildOpportunity({
          identity,
          productId: product.id,
          kind: 'data_quality',
          proposal: null,
        }),
      );
    }

    // DS040: campaign planning requires a named campaign plus explicit flags.
    const campaignId = product.campaignId === undefined ? null : product.campaignId;
    const campaignEligible = product.campaignEligible === undefined ? null : product.campaignEligible;
    const campaignEnrolled = product.campaignEnrolled === undefined ? null : product.campaignEnrolled;
    const campaignPrice = product.campaignPrice === undefined ? null : product.campaignPrice;
    const hasCampaign = campaignId !== null || campaignPrice !== null ||
      campaignEligible !== null || campaignEnrolled !== null;

    if (
      hasCampaign &&
      campaignId !== null &&
      campaignEligible !== null &&
      isExplicitlyTrue(campaignEligible) &&
      campaignEnrolled !== null &&
      isExplicitlyFalse(campaignEnrolled)
    ) {
      const planned = planCampaign({
        productId: product.id,
        campaignPrice,
        cost: product.cost,
        eligible: campaignEligible,
        enrolled: campaignEnrolled,
        minimumMargin,
      });

      for (const item of planned.items) {
        opportunities.push(
          buildOpportunity({
            identity,
            productId: product.id,
            kind: 'campaign',
            campaignId,
            proposal: {
              campaignId,
              campaignPrice,
              before: item.before,
              value: item.value,
            },
          }),
        );
      }
    }

    if (product.stock === null || product.warehouseAvailable === null) continue;

    const stockout = planStockout({
      productId: product.id,
      stock: product.stock,
      warehouseAvailable: product.warehouseAvailable,
    });

    for (const item of stockout.items) {
      opportunities.push(
        buildOpportunity({
          identity,
          productId: product.id,
          kind: 'inventory',
          proposal: { before: item.before, value: item.value },
        }),
      );
    }
  }

  return deepFreeze({ observation: normalized, opportunities, excluded });
}
