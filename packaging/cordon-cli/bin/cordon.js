#!/usr/bin/env node
process.stderr.write([
  "",
  "  cordon-cli has been renamed to @getcordon/cli.",
  "",
  "  Run:",
  "    npm install -g @getcordon/cli",
  "",
  "  The new package has the activation flow, the Windows OAuth fix,",
  "  the dashboard integration, and call-graph policies.",
  "",
  "  Repo: https://github.com/marras0914/cordon",
  "  Site: https://getcordon.com",
  "",
  ""
].join("\n"));
process.exit(1);
