# RSS-E: the RSSA enterprise profile — v0.1 (draft)

RSS-E is RSS-A with a fixed set of requirements that a buyer can write into a tender or security
checklist, in the way "FIPS mode" or "PCI-compliant" work. The profile is open: anyone can implement it,
and the validator tests for it. "RSS-E Certified" means a hub or group passed the published
conformance tests, with the results listed publicly.

| Requirement | RSS-E | Testable in v0.1? |
|---|---|---|
| Preset | `strict`, with no overrides that relax it | **yes**: the validator reports it (`rss-e` finding) |
| Signing | Required on entries, the group policy and Agent Cards | **yes** |
| Hub | Required, with identity attestation on every item | hub yes; attestation not until after the gate |
| Identity | Identity history log, plus verified organisation identity (eIDAS seal or vLEI) | not yet |
| Anchoring | Required: `tsa` at minimum, `rekor` and `chain` optional | not yet (`anchor` module) |
| Privacy | Private groups by default | not yet (`private` module) |
| Data residency | Hub and storage location declared in `policy.json` (`residency`) | field reserved |
| Audit | A sealed, exportable record of all group activity | not yet |

Until the reserved modules ship, no group can be fully RSS-E. The validator says so rather than
passing a partial profile.

Conformance tests and the publication format for certification results are to be written
before any certification is offered (design doc, launch checklist).
