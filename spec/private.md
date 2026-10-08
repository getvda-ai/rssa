# RSSA module: private — reserved

Not part of v0.1. Planned after the day-60 gate, in this order: controls enforcement, identity attestation, private, pay, anchor.

Members-only groups. v0.2: authenticated delivery (the hub issues a per-member token and the group feed requires it). v0.3: encrypted content (items encrypted to a group key that rotates when a member leaves).

Until this module is specified, implementations MUST NOT emit `rssa:` elements for it, and readers ignore any they see (must-ignore).
