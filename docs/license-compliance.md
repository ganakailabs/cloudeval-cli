# License Compliance

CloudEval CLI is a distributed client for a commercial SaaS product. The
recommended posture is:

- keep CloudEval-authored CLI code proprietary under `LICENSE`;
- allow customers to install and run official releases for CloudEval use;
- publish third-party notices and an SBOM with every binary release;
- allow permissive production dependencies by default; and
- block copyleft, source-available, unknown, or unlicensed production
  dependencies unless legal approval is recorded before release.

This is an engineering policy, not legal advice. Counsel should review the
first-party license before public or enterprise redistribution.

## Current First-Party License Choice

Use a proprietary CloudEval CLI license instead of MIT or Apache-2.0 for the
CLI itself.

Rationale:

- the CLI is a product surface for a hosted SaaS, not a standalone community
  library;
- customers need permission to install and run official releases, including in
  CI/CD;
- Ganak AI Labs should retain control over redistribution, managed-service
  wrappers, trademarks, and competing commercial use; and
- third-party open-source packages can remain under their own permissive terms
  without making CloudEval-authored code open source.

If the business later wants a fully open-source CLI, Apache-2.0 is the stronger
default than MIT because it includes an express patent license and keeps NOTICE
handling familiar for enterprise buyers.

## Runtime Dependency Policy

Allowed by default for production dependencies:

| License family | Policy |
| --- | --- |
| MIT, ISC, 0BSD | Allowed with attribution in `THIRD_PARTY_NOTICES.md`. |
| BSD-2-Clause, BSD-3-Clause | Allowed with attribution and disclaimer retention. |
| Apache-2.0 | Allowed with license text and NOTICE retention when upstream provides NOTICE content. |
| CC0-1.0 | Allowed for data/metadata. |

Blocked by default for production dependencies:

| License family | Risk |
| --- | --- |
| GPL, AGPL, LGPL | Copyleft obligations can attach to distributed binaries or linked/runtime components. |
| MPL, EPL, CDDL | File-level copyleft/source obligations need legal review before binary distribution. |
| SSPL, BUSL/BSL, Elastic, PolyForm | Source-available or use-restricted terms can conflict with commercial SaaS distribution. |
| Unknown, UNLICENSED | Cannot establish redistribution rights. |

Development-only dependencies may use broader terms, but they must not be
bundled into release binaries, release assets, installers, or customer-facing
packages.

## Required Release Artifacts

Every release should include:

1. `LICENSE`
2. `NOTICE`
3. `THIRD_PARTY_NOTICES.md`
4. `sbom.spdx.json`
5. SHA-256 checksums for the above artifacts and executable assets

The installer downloads the notice files into:

```bash
~/.local/share/cloudeval/licenses
```

## Local Commands

Regenerate notices and SBOM:

```bash
pnpm license:artifacts
```

Fail the build if production dependencies include denied licenses:

```bash
pnpm license:audit
```

Check the full production license summary:

```bash
pnpm licenses list --prod
```

## Historical Risk Removed

`ink-big-text` pulled in `cfonts@3.3.1`, which is `GPL-3.0-or-later`. The CLI
already uses static CloudEval-authored banner art, so `ink-big-text` was not
needed at runtime and should stay removed unless legal explicitly approves a
GPL-compatible distribution model.

