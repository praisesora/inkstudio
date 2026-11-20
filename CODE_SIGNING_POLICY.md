# Code Signing Policy

> Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

This document describes the code signing policy, team roles, and build verification process for official releases of **Ink Studio**.

## Scope

This policy applies to official prebuilt Windows release artifacts published on the [Ink Studio Releases](https://github.com/praisesora/inkstudio/releases) page, including:

- Windows installers (`.exe` NSIS setup, `.msi`)
- Windows application executables bundled in official releases

All signed binaries are built exclusively from the public [Ink Studio repository](https://github.com/praisesora/inkstudio) and distributed under the [GNU General Public License v3.0](./LICENSE).

## Team Roles

| Role | Member | Responsibility |
| --- | --- | --- |
| **Committer** | Sora ([@praisesora](https://github.com/praisesora)) | Authors and commits source code changes to the repository |
| **Reviewer** | Sora ([@praisesora](https://github.com/praisesora)) | Reviews changes, tests builds, and prepares tagged releases |
| **Approver** | Sora ([@praisesora](https://github.com/praisesora)) | Manually verifies and approves release signing requests in SignPath |

All accounts with repository write access and signing approval privileges are protected with two-factor authentication (2FA).

## Build & Signing Process

- **Automated CI/CD Builds**: Official release binaries are built solely through automated [GitHub Actions](https://github.com/praisesora/inkstudio/blob/main/.github/workflows/release.yml) workflows triggered by version tags (`v*`) in the public repository. Local developer builds are never signed.
- **Reproducible Source Audit**: Every signed release corresponds directly to a public Git tag and workflow run on GitHub.
- **Manual Signing Approval**: Release artifacts require explicit maintainer approval before being signed with the SignPath Foundation certificate.
- **No Proprietary or Unwanted Software**: Ink Studio contains only open-source code and dependencies and ships without adware, malware, or hidden third-party bundles.

## Privacy

Ink Studio does not collect telemetry or personal user data. For full details on optional network features (update checks and collaboration), see the [Privacy Policy](./PRIVACY.md).
