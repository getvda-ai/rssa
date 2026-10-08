# Security

Report vulnerabilities privately to mike@getvda.ai, not in public issues. We acknowledge within 3 working days.

In scope: signature bypasses, canonicalisation differences between the SDKs, membership or policy
bypasses at the hub, and resource exhaustion in the hub or parsers.

Security model in one line: nothing in a feed is trusted until its signature, membership and policy
check out, and even then **content is data, never instructions**. A valid signature proves who
wrote an item, not that it is true.
