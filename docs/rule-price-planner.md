# Rule price planner and diagnosis

The actual Demo diagnosis and preview now share `pricePlanning.js` rather than
hard-coded counts and a separate inline filter. `createRulePricePlanner()`
provides `proposePlan({ products, minimumMargin })`, returning only candidate
items and explicit exclusions. This is a deterministic price planner, not a
general natural-language Agent Runtime or an LLM integration.

Amounts must be nonnegative safe integers; target prices must be positive.
Missing targets are not zero-price proposals. Missing/invalid price or cost,
below-floor margin, and already-at-target items are not executable candidates.
An empty proposal cannot become a Demo action. Zero cost remains a known cost;
only numeric zero stock is counted as an observed stockout. Coverage records
how many product, cost and stock observations exist: no observations do not
prove a healthy store. All Demo inputs remain synthetic and isolated.

New diagnosis records include a rule version and are rechecked against the
fixed Demo products on save/reopen. Preview exclusions are now validated too.
Older diagnosis records without that marker retain their prior compatibility
path; no historical checks are invented or automatically rewritten.

The UI uses each new priority's product ID; the old fixed-ID mapping remains
only for old saves. Preview → explicit approval → local capability → mock
connector → readback verification is unchanged. Recommendations never grant
authorization and no realized-profit claim is generated.

Basic Planner/Memory hooks and local/async Agent composition are implemented;
stockout and fixed campaign mock flows also exist. Generic business schemas,
multi-intent planning, richer Memory, general multi-item UI and desktop
production RPA remain later work. Private host binding is not full Enterprise migration.
