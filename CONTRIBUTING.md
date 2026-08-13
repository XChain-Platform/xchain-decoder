# Contributing to XChain Decoder

Thanks for considering a contribution. `xchain-decoder` decodes untrusted on-chain data into protocol state, so we trade speed for correctness on every commit.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-Platform/xchain-documentation/tree/master/components/decoder) repository (architecture, configuration, database schema, operations)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- License: [`LICENSE.md`](./LICENSE.md) + [`NOTICE.md`](./NOTICE.md) (GNU Affero General Public License v3.0, dual-licensed)

---

## Repo layout in 30 seconds

```
xchain-decoder/
├── src/                  decoder pipeline: connector, parser, deobfuscation, DB writes, API
├── test/                 layered suites (unit, integration, e2e, fuzz, chaos, security, ...)
├── CHANGELOG.md          authoritative version history
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22** exactly. The platform pins Node 22 fleet-wide: the `mariadb` driver is ESM-only (Node 18 fails with `ERR_REQUIRE_ESM`), and newer majors are not validated against the stack. `engines.node` declares `>=22.0.0`; use 22.
- **MariaDB** reachable from the decoder host for anything beyond unit tests.
- **Docker** for the integration and e2e tiers. Each brings up its own throwaway regtest node and MariaDB on tmpfs and tears them down again, so neither needs (or touches) a coin node on the host.
- A coin node (`bitcoind` / `litecoind` / `dogecoind`) only for running the decoder itself against a chain. For local work, the `xchain-regtest-miner` plus a regtest stack is the easiest path.

### First-time install

```bash
git clone https://github.com/XChain-Platform/xchain-decoder.git
cd xchain-decoder
npm install
```

Create a `.env` (see [`README.md`](./README.md) for the full key list). **Never commit a `.env` or any real credential.** Secrets live only in the local `.env`, loaded at runtime; never hard-code them into source, tests, or scripts.

---

## Running it

```bash
npm run api        # start the decoder + API server
npm run migrate    # apply database migrations
```

---

## Tests

The decoder runs a layered suite. Pick the tier that matches your change:

| Tier | Command | Needs external services | Gated by |
|---|---|---|---|
| Smoke | `npm run test:smoke` | No | `npm run ci` |
| Unit | `npm run test:unit` | No | `npm run ci` |
| Security | `npm run test:security` | No | `npm run ci` |
| Regression | `npm run test:regression` (`:critical` = P0 only) | No | `npm run ci` |
| Chaos | `npm run test:chaos` | No | `npm run ci` |
| Fuzz | `npm run test:fuzz` (`:quick` for 100 iterations) | No | `npm run ci` (100-iteration pass) |
| Integration | `npm run test:integration` | Docker (the tier starts its own throwaway regtest node and MariaDB) | CI job `docker-suites` |
| End-to-end | `npm run test:e2e` | Docker (its own throwaway regtest node and MariaDB, on separate ports from the integration tier) | CI job `docker-suites` |
| Benchmarks | `npm run test:bench` | No | Nothing, on purpose (see below) |
| Mutation | `npm run test:mutation` | No | Nothing, on purpose (see below) |

`npm run ci` is the whole no-external-services gate and takes about a minute: unit,
security, smoke, regression, chaos, and a 100-iteration fuzz pass. Run it before every
commit. The docker tiers cannot run inside it (each brings its own containers up), so
they run as their own workflow job instead.

Benchmarks and mutation runs are deliberately ungated: benchmarks measure throughput
against a baseline that shared CI runners cannot reproduce, and a Stryker run re-executes
the unit suite once per mutant. Both are periodic audits you run on a fixed machine, not
per-push gates.

`test/tier-manifest.json` is the authoritative map of tier to gate, and
`test/unit/tierManifest.test.js` enforces it: adding a tier without wiring it into a gate
(or writing down why it has none) fails CI, and so does a gate glob that has stopped
matching its files. Add the manifest entry in the same commit as the tier.

New parsing or deobfuscation logic should come with fuzz and security coverage, since
this service's entire input surface is attacker-controlled.

---

## Coding style

- **Plain JavaScript**, no TypeScript. Raw parameterized SQL via the `mariadb` driver, no ORM.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, a consensus-relevant constraint, a workaround with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Determinism matters.** Decoder output feeds consensus. Avoid wall-clock time, locale-dependent formatting, or any nondeterminism in the parse path.

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

CI runs the no-external-services gate, the docker tiers, the cross-repo drift guards, and the coverage ratchet. Before opening a PR:

1. Run `npm run ci` and confirm it passes.
2. Update `CHANGELOG.md` with a terse entry for your change.
3. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers, no `.env`).
4. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-Platform/xchain-decoder/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

Last reviewed: 2026-06-16.
