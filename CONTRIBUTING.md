# Contributing

- **Sign off your commits** (`git commit -s`, Developer Certificate of Origin). There is no CLA.
- Spec changes: open a `proposal` issue first (see GOVERNANCE.md).
- Code changes: `npm test && npm run check` and `cd packages/sdk-py && python -m pytest` must pass.
  If you change signing or canonicalisation, regenerate the vectors (`npm run vectors`) and explain
  why in the PR. Changing a vector is a breaking change.
- Every new validator check needs a file in `demo/broken/` that fails it, listed in `EXPECTED.json`.
  A check that has never been seen failing doesn't count.
- Adoption reports (things that were harder than they should be) are welcome as issues titled `[adoption] …`.
