# Radioso Enterprise Edition

This directory contains Radioso Enterprise Edition code. It is commercial
source-available software governed by [LICENSE](./LICENSE), not by the
open-source license that may apply to the rest of this repository.

Enterprise Edition packages live under `ee/packages` so they can keep package
boundaries without requiring a second repository.

## Local development

From the repository root:

```bash
./run-ee-dev.sh
```

From this directory:

```bash
npm run build
npm test
```
