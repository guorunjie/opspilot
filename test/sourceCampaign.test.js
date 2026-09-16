import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourceObservation } from '../src/domain/model/sourceObservation.js';
import { buildSourceOpportunities } from '../src/domain/model/sourceOpportunities.js';

const NOW = '2026-09-16T00:00:01.000Z';
const OBSERVED = '2026-09-16T00:00:00.000Z';
const BASE = {
  id: 'x', price: 1000, cost: 400, stock: 0, referencePrice: 950,
  warehouseAvailable: 10, campaignId: 'c', campaignPrice: 800,
  campaignEligible: true, campaignEnrolled: false,
};

const opts = (over = {}) => ({
  expectedScope: { platformId: 'p', storeId: 's' },
  now: NOW, maxAgeMs: 60000, ...over,
});

const obs = (products, over = {}) => ({
  observationId: 'o', sourceId: 's', mode: 'synthetic', platformId: 'p',
  storeId: 's', observedAt: OBSERVED, products, ...over,
});

const build = (products, over = {}) =>
  buildSourceOpportunities(obs(products), opts(over));

const campaigns = (r) => r.opportunities.filter((o) => o.kind === 'campaign');
const others = (r) => r.opportunities.filter((o) => o.kind !== 'campaign');
const clone = (p) => ({ ...BASE, ...p });

test('baseline campaign proposal: exact shape, non-executable, requires approval', () => {
  const r = build([clone()]);
  assert.equal(campaigns(r).length, 1);
  const [c] = campaigns(r);
  assert.deepStrictEqual(c.proposal, { campaignId: 'c', campaignPrice: 800, before: 0, value: 1 });
  assert.equal(c.executable, false);
  assert.equal(c.requiresApproval, true);
});

test('zero cost is valid and still yields the campaign (margin1)', () => {
  for (const cost of [0, 0.0]) {
    const [c] = campaigns(build([clone({ cost })]));
    assert.ok(c, `cost ${cost} must produce a campaign opportunity`);
    assert.deepStrictEqual(c.proposal, { campaignId: 'c', campaignPrice: 800, before: 0, value: 1 });
  }
});

test('missing/null booleans are never coerced to false', () => {
  for (const eligible of [undefined, null]) {
    for (const enrolled of [undefined, null]) {
      const p = clone({ campaignEligible: eligible, campaignEnrolled: enrolled });
      if (eligible === undefined) delete p.campaignEligible;
      if (enrolled === undefined) delete p.campaignEnrolled;
      assert.equal(campaigns(build([p])).length, 0,
        `eligible=${eligible} enrolled=${enrolled} must not default to false`);
    }
  }
});

test('absent/null campaignId, campaignPrice or cost => no campaign opportunity', () => {
  for (const field of ['campaignId', 'campaignPrice', 'cost']) {
    for (const bad of [undefined, null]) {
      const p = clone({ [field]: bad });
      if (bad === undefined) delete p[field];
      const r = build([p]);
      assert.equal(campaigns(r).length, 0, `${field}=${bad} must not yield a campaign`);

    }
  }
});

test('rejects string boolean, number campaign ID and negative campaign price', () => {
  const bad = [
    clone({ campaignEligible: 'true' }),
    clone({ campaignId: 7 }),
    clone({ campaignPrice: -1 }),
  ];
  for (const p of bad) {
    assert.throws(() => build([p]), TypeError);
  }
});

test('minimumMargin defaults to .2 (passes) and explicit .8 rejects price800/cost400', () => {
  assert.equal(campaigns(build([clone()])).length, 1);
  const strict = build([clone()], { minimumMargin: 0.8 });
  assert.equal(campaigns(strict).length, 0);
});

test('distinct campaign IDs => distinct campaign IDs, unchanged pricing/inventory IDs', () => {
  const single = build([clone()]);
  const dual = build([clone({ campaignId: 'c2' })]);
  const ids = campaigns(dual).map((o) => o.id);
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], campaigns(single)[0].id);
  assert.deepStrictEqual(
    others(dual).map((o) => o.id).sort(),
    others(single).map((o) => o.id).sort(),
  );
});

test('scope mismatch and stale observation => UNKNOWN with no opportunities', () => {
  const cases = [
    { expectedScope: { platformId: 'q', storeId: 's' } },
    { now: '2026-09-16T00:05:00.000Z' },
  ];
  for (const over of cases) {
    const r = build([clone()], over);
    assert.equal(r.observation.status, 'UNKNOWN');
    assert.deepStrictEqual(r.opportunities, []);
  }
});

test('no campaign fields in input => none in normalized output; only campaignId => other three null', () => {
  const bare = { id: 'x', price: 1000, cost: 400, stock: 0 };
  const n1 = normalizeSourceObservation(obs([bare]), opts()).products[0];
  for (const f of ['campaignId', 'campaignPrice', 'campaignEligible', 'campaignEnrolled']) {
    assert.equal(n1[f], undefined);
  }
  const n2 = normalizeSourceObservation(obs([{ ...bare, campaignId: 'c' }]), opts()).products[0];
  assert.equal(n2.campaignId, 'c');
  assert.equal(n2.campaignPrice, null);
  assert.equal(n2.campaignEligible, null);
  assert.equal(n2.campaignEnrolled, null);
});

test('campaign proposals are deeply frozen', () => {
  for (const c of campaigns(build([clone()]))) {
    assert.ok(Object.isFrozen(c));
    for (const v of Object.values(c)) {
      if (v && typeof v === 'object') assert.ok(Object.isFrozen(v));
    }
    assert.throws(() => { c.proposal.value = 2; }, TypeError);
  }
});

test('each absent flag, ineligible or already-enrolled state independently blocks a proposal', () => {
  for (const patch of [{ campaignEligible: null }, { campaignEnrolled: null },
    { campaignEligible: false }, { campaignEnrolled: true }]) {
    assert.equal(campaigns(build([clone(patch)])).length, 0);
  }
});
