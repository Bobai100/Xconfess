# Safe Reproduction Bundles

Generate a bundle only when a contributor has opted in:

```sh
npm run diagnose -- --bundle /path/to/reproduction-bundle.json
```

The bundle contains Node/npm and application versions, platform/architecture,
database and Redis reachability states, and environment variable names only.
It excludes variable values, hostnames, Git remotes/commits, logs, request data,
confession content, and user identifiers. The command validates the bundle
schema and scans its serialized output for credential and personal-identifier
patterns before it is made available. Files are created with owner-only
permissions; review the JSON before sharing it through an access-controlled
issue or support channel.