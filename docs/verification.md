# Verification

Run the declared host checks from a clean source checkout:

```sh
npm run bootstrap
npm run source:audit
npm run check
npm run parity -- --maxWorkers=1
npm run inventory:test
npm run native:test
npm run live:installer:test
```

Run affected SDK, browser/native workflow and adapter tests as described in the
[developer guide](developer-guide.md). Keep reports in ignored local directories
and share redacted summaries. Evidence must name its source/candidate/profile.
Desktop/browser/emulator tests do not establish physical audio, storage or input
qualification. See [release status](../RELEASE.md) and [known issues](known-issues.md).
