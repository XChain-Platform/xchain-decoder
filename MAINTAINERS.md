# Maintainers

This file lists the people responsible for `xchain-decoder`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: polling pipeline, parsing, deobfuscation, database layer, API, releases |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-decoder/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| Block polling | Node JSON-RPC polling loop, chain-tip tracking, block reorganization detection and rollback |
| Transaction parsing | `parseTransaction`, the four encoding formats, chain-specific header handling (Litecoin MWEB, Dogecoin AuxPoW) |
| Deobfuscation | AES-128-CTR key/IV derivation from the first input txid, payload extraction |
| Database layer | The decoder schema, migrations, and parameterized writes to the decoder DB |
| DISPENSER and mempool | Dispenser lifecycle tracking, mempool indexing of unconfirmed transactions |
| API | The decoder HTTP API (`src/api.js`) |
| Tests | The layered suites under `test/` (unit, integration, e2e, fuzz, chaos, security, regression) |
| Documentation | `README`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, `CHANGELOG` |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: deterministic parsing (decoder output feeds consensus), raw parameterized SQL with no ORM, the `Keep a Changelog` format, and Node 22 as the pinned runtime.

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| A decode or parsing bug that may have corrupted indexed state | Open a public issue tagged `consensus` AND email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

---

## Decision-making

The lead makes final calls on:

- Parsing and decode behavior that affects what downstream consensus sees.
- Database schema and migration changes.
- Release timing and version policy.
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (bug fixes, additions within an existing area, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-indexer`](https://github.com/XChain-platform/xchain-indexer) | Consumes the decoder database; the decoder's output is the indexer's input |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Protocol spec: ACTION definitions, encoding formats, database naming |
| [`xchain-node`](https://github.com/XChain-platform/xchain-node) | Installs and runs the decoder as a Docker container |
| Coin nodes (`bitcoind` / `litecoind` / `dogecoind`) | The decoder polls these via JSON-RPC; they are upstream projects, not maintained here |

The decoder maintainer is not automatically a maintainer of those sibling projects. Cross-project changes go through each project's own review process.
