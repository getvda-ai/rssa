# RSSA module: anchor — reserved

Not part of v0.1. Planned after the day-60 gate, in this order: controls enforcement, identity attestation, private, pay, anchor.

Independent proof that an item existed, unchanged, at a given time: `<rssa:anchor type="tsa|rekor|chain" …/>`, any number per item, with the group's policy saying which types it requires. Only hashes are anchored, never content. Anchoring records events; it never gates them.

Until this module is specified, implementations MUST NOT emit `rssa:` elements for it, and readers ignore any they see (must-ignore).
