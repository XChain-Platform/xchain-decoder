# Fuzz Seed Corpus

Place curated seed inputs here. The fuzz harnesses use these as starting points
for mutation-based fuzzing.

Current seeds are loaded from:
- `test/fixtures/crypto.json`, known-good encrypted XCHN payloads
- Hardcoded tx hex in `test/unit/parseTransaction.test.js`, covering OP_RETURN,
  multisig, P2SH and P2WSH carriers

To add mainnet seeds, export real XChain transactions as hex and place them in
JSON files here (e.g., `mainnet_opreturn.json`).
