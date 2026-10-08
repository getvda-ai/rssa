"""Cross-language check: the Python SDK reads and verifies the demo feeds the JS SDK signed."""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "packages" / "sdk-py"))

import rssa  # noqa: E402

BASE = "https://demo.rssa.getvda.ai"
SITE = pathlib.Path(__file__).resolve().parents[1] / "demo" / "site"


def fetch(url: str):
    if not url.startswith(BASE):
        return 404, ""
    p = SITE.joinpath(*url[len(BASE):].strip("/").split("/"))
    return (200, p.read_text(encoding="utf-8")) if p.is_file() else (404, "")


bad = 0
total = 0
for feed in ["brewer/rssa/feed.atom", "supplier/rssa/feed.rss", "logistics/rssa/feed.json"]:
    r = rssa.read_feed(f"{BASE}/{feed}", fetch=fetch, require_signatures=True)
    for e in r.entries:
        total += 1
        bad += not e.verified
    for p in r.problems:
        print(f"  problem in {feed}: {p}")
        bad += 1
    print(f"  python: {feed}: {sum(e.verified for e in r.entries)}/{len(r.entries)} verified")

policy = rssa.strict_parse((SITE / "groups/supply-ops/policy.json").read_text(encoding="utf-8"))
pok, err = rssa.verify_policy(policy, fetch)
print(f"  python: policy signature {'valid' if pok else 'INVALID: ' + str(err)}")
bad += not pok
print("ALL VERIFIED" if not bad and total == 6 else f"{bad} problems")
sys.exit(1 if bad else 0)
