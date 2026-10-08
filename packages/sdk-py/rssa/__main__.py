"""python -m rssa — keygen, add-to-card, verify, sign-policy."""

import argparse
import json
import os
import sys

from . import generate_key, load_key, read_feed, roster_opml, sign_card, sign_policy, with_rssa
from .canonical import strict_parse


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="rssa", description="RSS-A (RSS for Agents). Full validation: rssa validate <url> (the Node CLI, bin/rssa in the repo)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    k = sub.add_parser("keygen", help="create an Ed25519 key; prints the public JWKS for your card")
    k.add_argument("--out", default="rssa-key.json")
    a = sub.add_parser("add-to-card", help="add the RSSA extension line to an Agent Card file, in place")
    a.add_argument("card")
    a.add_argument("--feed", required=True)
    a.add_argument("--key")
    a.add_argument("--modules")
    sc = sub.add_parser("sign-card", help="sign an Agent Card (A2A native signatures field), in place")
    sc.add_argument("card")
    sc.add_argument("--key", required=True)
    v = sub.add_parser("verify", help="fetch a feed and verify every signed entry")
    v.add_argument("url")
    p = sub.add_parser("sign-policy", help="sign a group policy.json in place and write roster.opml beside it")
    p.add_argument("policy")
    p.add_argument("--key", required=True)
    args = ap.parse_args(argv)

    if args.cmd == "keygen":
        if os.path.exists(args.out):
            print(f"rssa: {args.out} exists; refusing to overwrite a key", file=sys.stderr)
            return 2
        key = generate_key()
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(key.private_jwk, f, indent=2)
        print(f"Private key written to {args.out}. Keep it secret; load it at runtime with rssa.load_key() or RSSA_KEY.", file=sys.stderr)
        print("Paste this into your Agent Card's RSSA params as \"keys\":", file=sys.stderr)
        print(json.dumps(key.public_jwks(), indent=2))
        return 0
    if args.cmd == "add-to-card":
        with open(args.card, encoding="utf-8") as f:
            card = json.load(f)
        key = load_key(args.key) if args.key else None
        modules = args.modules.split(",") if args.modules else (["sign"] if key else None)
        card = with_rssa(card, feed=args.feed, modules=modules, keys=key.public_jwks() if key else None)
        with open(args.card, "w", encoding="utf-8") as f:
            json.dump(card, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"Added the RSSA extension to {args.card}. Next: publish {args.feed}, then sign the card (rssa sign-card) and run: rssa validate <your agent URL>")
        return 0
    if args.cmd == "sign-card":
        with open(args.card, encoding="utf-8") as f:
            card = json.load(f)
        signed = sign_card(card, load_key(args.key))  # before opening for write, so a bad key can't truncate the card
        with open(args.card, "w", encoding="utf-8") as f:
            json.dump(signed, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"Signed {args.card}. Re-sign after every change to the card.")
        return 0
    if args.cmd == "verify":
        r = read_feed(args.url, require_signatures=False)
        bad = 0
        for e in r.entries:
            mark = "OK " if e.verified else ("-  " if not e.entry.sig else "BAD")
            bad += bool(e.entry.sig and not e.verified)
            print(f"{mark} {e.entry.id} {e.entry.type or ''}")
            for c in e.checks:
                if not c.ok:
                    print(f"      {c.message}")
        for msg in r.problems:
            print(f"WARN {msg}")
        return 1 if bad or r.problems else 0
    if args.cmd == "sign-policy":
        with open(args.policy, encoding="utf-8") as f:
            policy = strict_parse(f.read())
        signed = sign_policy(policy, load_key(args.key))
        with open(args.policy, "w", encoding="utf-8") as f:
            json.dump(signed, f, indent=2, ensure_ascii=False)
            f.write("\n")
        opml = os.path.join(os.path.dirname(args.policy) or ".", "roster.opml")
        with open(opml, "w", encoding="utf-8") as f:
            f.write(roster_opml(signed))
        print(f"Signed {args.policy} (version {signed['version']}) and wrote {opml}. Bump version on every change.")
        return 0
    return 2


if __name__ == "__main__":
    sys.exit(main())
