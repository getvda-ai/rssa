# RSSA module: sign — v0.1 (draft)

**Sign a small JSON payload, never the XML.** Feed tools may reformat, re-indent or convert the
feed freely. The signature covers only the payload and a hash of the summary and content.

> Use the SDKs. `signEntry`/`sign_entry` and `verifyEntry`/`verify_entry` implement everything
> below. If you write your own implementation, it MUST pass [`test-vectors/`](../test-vectors).

## 1. Keys

- Algorithm: **Ed25519** (JWS `alg: "EdDSA"`), keys as JWK (`kty: "OKP"`, `crv: "Ed25519"`).
- Key id: the JWK `kid`, or else the RFC 7638 thumbprint of the public key.
- The card's `params.keys` is one of:
  - an inline JWKS `{"keys":[{…public JWK…}]}` (RECOMMENDED: nothing else to host);
  - an https URL of a JWKS document, or of an Agent Card whose RSSA params contain `keys`;
  - `did:web:host[:path]` (the DID document's `verificationMethod[].publicKeyJwk`).

## 2. The signable subset (canonical JSON)

Signed JSON is canonicalised with JCS (RFC 8785), **restricted** to:

- strings, `true`/`false`, `null`, arrays and objects;
- integers with |n| ≤ 2^53 − 1.

Implementations MUST reject:

- any number with a fraction or exponent (`12.5`, `1.0`, `1e3`). Amounts and measurements go as strings (`"12.50"`);
- integers outside the safe range;
- duplicate object keys;
- strings containing a lone surrogate.

Inside this subset JCS has exactly one output. Object keys are sorted by UTF-16 code units, there is
no whitespace, and strings are escaped as in ECMAScript `JSON.stringify` (`\"`, `\\`, `\b`, `\f`,
`\n`, `\r`, `\t`, other controls as lowercase `\u00xx`, everything else as literal UTF-8).

## 3. Entry payload

| Field | Required | Value |
|---|---|---|
| `id` | yes | The entry id, exactly as in the feed. |
| `updated` | yes | The entry's updated time (RFC 3339). Compared as an instant. |
| `feed` | yes | The URL of the feed the entry is published in (its `rel="self"`). |
| `contentHash` | yes | `sha256:` + lowercase hex of SHA-256 over the **hash input** (§4). |
| `type`, `to`, `source`, `inReplyTo`, `reaction` | when present in the entry | Copied exactly. A field present on one side and absent on the other fails verification. |

Other fields MUST NOT appear in v0.1 payloads. (Payloads are flat; no nesting is needed.)

## 4. Hash input

```
contentHashInput = JCS({ "summary": norm(summary), "content": norm(content) })
norm(s) = s with every CRLF or CR replaced by LF, then leading/trailing whitespace trimmed
```

Absent fields are omitted from the object, so an entry with neither hashes `{}`. "Text" means
the element's character data after XML parsing (CDATA and entity escapes are equivalent), or the
JSON Feed string (`content_text`, else `content_html`). Entries with Atom `type="xhtml"` content
MUST NOT be signed. Use `text` or `html`.

The **title is not signed**. Consumers MUST NOT act on titles.

## 5. Signature

`rssa:sig` is a **detached compact JWS** (RFC 7515 Appendix F):

```
header    = BASE64URL(JCS({"alg":"EdDSA","kid":"<kid>"}))
input     = header + "." + BASE64URL(JCS(payload))
rssa:sig  = header + ".." + BASE64URL(Ed25519-Sign(input))
```

`rssa:payload` carries the payload JSON. Publishers SHOULD write it in canonical form. Verifiers
MUST parse it with the restrictions of §2 and canonicalise it again before verifying.

```xml
<entry>
  <id>urn:uuid:7c1e…</id>
  <updated>2026-10-05T14:20:00Z</updated>
  <summary>Order 88231 delayed 48h: port congestion at Rotterdam.</summary>
  <rssa:type>exception.reported</rssa:type>
  <rssa:to>role:logistics</rssa:to>
  <rssa:payload>{"contentHash":"sha256:…","feed":"https://agent.example.com/rssa/feed.atom","id":"urn:uuid:7c1e…","to":"role:logistics","type":"exception.reported","updated":"2026-10-05T14:20:00Z"}</rssa:payload>
  <rssa:sig>eyJhbGciOiJFZERTQSIsImtpZCI6Ii4uLiJ9..3q2-…</rssa:sig>
</entry>
```

## 6. Verification

A consumer verifies an entry, attributed to feed `F`, as follows:

1. Parse `rssa:payload` under §2 → payload object.
2. `payload.id` = entry id; `payload.updated` = entry updated (as instants); `payload.feed` = `F`.
3. Each of `type, to, source, inReplyTo, reaction` is equal in payload and entry, or absent from both.
4. `payload.contentHash` = recomputed hash (§4).
5. The JWS verifies over `JCS(payload)` with a key from `F`'s card, matched by `kid`.

`F` is the feed the entry was fetched from. In a hub-merged feed, `F` is the entry's
`atom:source` self link, and the keys come from the card that source feed links to.

**A valid signature proves who wrote an item, not that it is true.**

## 7. Agent Cards

Agent Cards are signed with **A2A's native `signatures` field**: a JWS over the RFC 8785
canonical card without `signatures`, `alg: "EdDSA"`, using a key from the card's own `params.keys`.
RSSA does not define a second card signature. (`rssa sign-card` does this.)

**Cards that already carry another signature.** Some cards embed their own proof (e.g. a `proof`
object). Each scheme strips only its own field, so whichever signature is computed first breaks when
the other is added. The order is fixed:

1. Add the RSSA line (and any other content).
2. Compute any other embedded proof. Its canonicalisation MUST exclude `signatures` as well as its own field.
3. Compute the A2A `signatures` **last**. It covers everything, including the other proof.

Verifiers of other embedded proofs MUST remove `signatures` before checking them.

## 8. Group policies

`policy.json` is signed with the same JWS construction over `JCS(policy without "sig")`. The
result goes in its `sig` field, and the key comes from the policy's `owner` reference.
