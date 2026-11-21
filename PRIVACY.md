# Public-source boundary

This repository contains community source, specifications, tests, original
practice assets and required third-party attribution. It excludes private
conversation/session records, personal or device identifiers, credentials,
local account/hosting settings, owner firmware/runtime images and internal
campaign material. Narrated videos and private narration tools are excluded;
use the [published manual](https://abstracteng.com/xmpos/manual/) for that course.

`npm run source:audit` inspects tracked files, embedded base64 modules and ZIP
members, reporting locations/rules without echoing sensitive matched values.
It is a safeguard, not a guarantee that every possible personal detail can be
recognized. Maintainers can supply additional private terms from a local file;
never commit that file. Review new release archives as well as the source tree.
Required upstream licence notices and their public author attribution remain.

History is fresh. Do not merge or push older development/mirror histories into
this repository. Use a clean clone after a privacy rewrite. Retire old release
archives and tags when replacing a snapshot. For old cached commits or external
copies, follow GitHub's sensitive-data removal procedure; rewriting branches
alone cannot erase copies held elsewhere.
