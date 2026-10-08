# Governance

**Steward:** Rawson Consulting B.V. During v0.x it is the editor and has the final say.

1. **Proposals.** Changes to the spec, the registry (core item types, anchor types, policy settings) or
   the presets are opened as issues labelled `proposal`, with a **14-day comment window** before a decision.
2. **v1.0 of a module** requires **two independent implementations** before it is frozen (the W3C rule
   of thumb). For the hub, that means a second operator not run by getvda.
3. **Versioning.** The core version is in the extension URI (`/ext/v0.1`); each module carries its own
   version. Breaking changes bump the version, so old and new agents can coexist.
4. **No vendor dependency.** The spec never requires any getvda service. The 0.x identifiers live under
   `rssa.getvda.ai` and the repo under `getvda-ai`. That is a hosting choice, not a dependency: anyone may
   implement, host hubs and run groups.
5. **Neutrality at v1.0.** If the day-60 gate passes, v1.0 moves the extension URI and namespace to a
   neutral domain and the repo to a neutral organisation. During the switch, readers accept both the v0.x and v1.0 URIs.
   If the gate fails, RSS-A stays a getvda suite feature and nothing moves.
6. **After adoption:** propose RSS-A as a registered A2A extension under the Linux Foundation, or move
   it to a neutral foundation.
