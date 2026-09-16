# Source observations and read-only opportunities

Development API; not included in the v0.1.1 release. These pure functions perform no collection, browser navigation, authorization or execution. A Connector/host supplies scoped observations through its own authorized read path. Core does not import private production Connectors.

```js
import { normalizeSourceObservation } from 'opspilot/source-observation';
import { buildSourceOpportunities } from 'opspilot/source-opportunities';

const input = {
  observationId: 'example-observation-1', sourceId: 'example-connector',
  mode: 'synthetic', platformId: 'example-platform', storeId: 'example-store',
  observedAt: '2026-09-16T00:00:00.000Z',
  products: [{ id: 'example-product', price: 1000, cost: 500,
    referencePrice: 950, stock: 0, warehouseAvailable: 4 }]
};
const options = {
  expectedScope: { platformId: 'example-platform', storeId: 'example-store' },
  now: '2026-09-16T00:00:01.000Z', maxAgeMs: 60000
};
const observation = normalizeSourceObservation(input, options);
const report = buildSourceOpportunities(input, { ...options, minimumMargin: 0.2 });
```

This example is synthetic, not production evidence. Hosts must explicitly use `mode: 'host'` for host-supplied records, bind the requested scope to the authenticated user's allowed store, and derive observed identities from authoritative platform evidence. Merely writing `host` or matching a supplied ID does not prove identity.

## Data rules

- Prices and costs use integer minor currency units; quantities are nonnegative safe integers. Mixed currencies, unit conversion and fractional inventory are not inferred.
- Missing or null numeric values remain null. Known zero remains zero. Coverage reports actual known counts, not completeness of the platform catalog.
- IDs are nonempty trimmed strings, at most 128 characters, without control characters. Duplicate product IDs, unexpected keys, getters, symbols, sparse arrays and nonordinary object prototypes are rejected. Trusted parsed JSON is the input boundary, not arbitrary executable objects or Proxies.
- UTC timestamps require milliseconds. The caller supplies `now` and an integer age limit from 1 to 86,400,000 milliseconds. Wrong scope, stale or future observations produce `UNKNOWN`, no product payload and no recommendations.
- `READY` means structurally valid, fresh and matching the expected scope only. It is not authenticated identity, user authorization, platform health or business `VERIFIED`.

## Recommendations are not actions

Price suggestions reuse the existing margin rule; absent reference prices do not imply a zero target. Inventory suggestions require observed zero stock and known positive available stock. Missing cost creates a non-executable data-quality item. Input data is copied and results are deeply frozen.

Every opportunity retains observation/source/platform/store identity and timestamp. IDs are deterministic within that observation, not an execution-idempotency key. Hosts must use immutable previews, their existing confirmation/role/refusal/lock checks, fresh current-state validation, persistent execution IDs, and item-by-item readback. Do not submit these objects directly as commands or reuse a recommendation ID as authorization. `requiresApproval` is descriptive; `executable` is always false.

Optional campaign fields are `campaignId`, `campaignPrice`, `campaignEligible`, and `campaignEnrolled`. A campaign recommendation needs a named campaign, known price/cost, explicit eligibility true and enrollment false, and the existing margin rule to pass. Missing flags remain unknown; zero cost is known. This contract represents one observed campaign offer per product per observation, not an exhaustive campaign catalogue. Campaign IDs participate in campaign opportunity identity. Private hosts must preserve the platform offer mapping; the generic proposal is not a platform enrollment request.

Task evidence and production execution continue through host binding. A confirmation digest associates records only. Missing required execution or readback evidence remains UNKNOWN. This module cannot upgrade an execution state.
