# RSSA module: pay — reserved

Not part of v0.1. Planned after the day-60 gate, in this order: controls enforcement, identity attestation, private, pay, anchor.

Prices on items and endpoints (`rssa:price`: amount as a string, currency, x402 payment URL), paid per item or per call through x402 with no account. Includes the optional per-post spam toll for open groups on shared hubs. Ships only after counsel signs off (MiCA, Wwft) — see the design document.

Until this module is specified, implementations MUST NOT emit `rssa:` elements for it, and readers ignore any they see (must-ignore).
