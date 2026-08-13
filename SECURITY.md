# Security Policy

`xchain-decoder` polls cryptocurrency nodes, parses every block, and decodes XChain-encoded transactions into a MariaDB database that the indexer consumes. It processes fully untrusted, attacker-controlled input (raw on-chain transaction data), and its output feeds protocol consensus state downstream. A parsing or deobfuscation flaw here can corrupt indexed state across the fleet, so we treat reports seriously and respond fast.

If you've found a security issue, please **do not open a public issue or pull request**. Use the private channels below.

---

## How to report

### Preferred: GitHub Private Vulnerability Reporting

Open a draft advisory at:

<https://github.com/XChain-Platform/xchain-decoder/security/advisories/new>

This is the fastest path. The advisory is private until we publish it.

### Alternative: Email

Email **security@dankest.llc** with:

- A description of the issue and the threat it poses.
- Reproduction steps or a proof-of-concept (a crafted transaction, block, or payload that triggers the bug).
- The affected version (see `CHANGELOG.md` and the version badge in `README.md`) and the network you tested against (mainnet / testnet / regtest, and which chain).
- Any patches or mitigations you'd like considered.

For sensitive reports, encrypt the email body to our PGP key. The fingerprint will be published alongside the first signed release artifact; until then, the email channel is acceptable for first contact and we will coordinate an encrypted exchange before you share proof-of-concept details.

We do not currently offer a paid bug bounty. We do offer public credit in release notes and the advisory itself, unless you prefer to remain anonymous.

---

## Response timeline

| Stage | Target |
|---|---|
| Initial acknowledgement | within 72 hours |
| Triage + severity assignment | within 7 days |
| Fix or mitigation in master | within 30 days for high/critical, 90 days for lower severities |
| Coordinated public disclosure | up to 90 days from initial report, or sooner if a fix has shipped and operators are protected |

If we cannot meet a timeline, we will tell you why and propose a new one. We will not silently let a report age.

---

## Scope

### In scope

- The block-polling and parsing pipeline in `src/` (transaction parsing, the four encoding formats, chain-specific header handling).
- AES-128-CTR deobfuscation of ACTION payloads and the key/IV derivation.
- ACTION name validation and any path that writes to the decoder database.
- SQL construction and parameterization against the MariaDB layer.
- Block-reorganization detection and rollback correctness.
- DISPENSER parsing and mempool-tracking code paths.
- The decoder HTTP/API surface exposed by `npm run api`.
- Denial-of-service via crafted blocks, transactions, or payloads that crash, hang, or exhaust resources in the decoder.

### Out of scope

- Vulnerabilities in the underlying coin node (`bitcoind` / `litecoind` / `dogecoind`); report those to their respective projects.
- Compromise of upstream npm dependencies (we mitigate via audit + review, but a backdoor in a dep is the dep author's incident, though we still want to hear about it).
- Misconfiguration of the operator's own MariaDB, RPC credentials, or network exposure (for example, binding the API to a public interface without a firewall).
- Attacks that require the operator's database credentials or shell access to the decoder host.
- Findings in downstream services (`xchain-indexer`, `xchain-explorer`); report those against their own repositories, unless the root cause is decoder output.

If you are unsure, send the report anyway and we will tell you whether it falls in scope.

---

## What we ask

- Give us a reasonable window to fix before disclosing publicly. The 90-day ceiling is firm; earlier is fine once a fix has shipped and operators are protected.
- Test against `regtest` or `testnet` where possible (the `xchain-regtest-miner` plus a local stack make this easy). Mainnet proofs-of-concept are accepted but should be the minimum needed.
- Do not run automated scanners against shared XChain infrastructure in a way that would impact availability for other operators.
- Do not access data, or attempt to access data, beyond what is needed to demonstrate the issue.

---

## What we will do

- Confirm receipt within the SLA above.
- Keep you informed as triage and remediation proceed.
- Credit you in the advisory and `CHANGELOG.md` entry, on request.
- Coordinate a CVE assignment when the severity warrants it.
- Publish a post-fix advisory describing the issue, the fix, and the affected version range.

---

## Versions covered

We ship security fixes against the latest release on `master`. Older releases are unsupported. The current version is recorded in `CHANGELOG.md` and the badge in `README.md`.

---

Last reviewed: 2026-06-16.
