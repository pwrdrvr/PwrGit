#!/usr/bin/env bash
set -euo pipefail

# Run outside configure-nodejs: its composite substeps share the expired step
# deadline, which can cancel its internal always() phase-timing reporter too.
if [[ "${1:-}" == "start" ]]; then
  echo "started-at=$(date +%s)" >> "$GITHUB_OUTPUT"
elif [[ "${1:-}" == "report" ]]; then
  elapsed=$(( $(date +%s) - DEPENDENCY_SETUP_STARTED_AT ))
  message="Dependency setup: outcome=$DEPENDENCY_SETUP_OUTCOME; elapsed=${elapsed}s; timeout=${DEPENDENCY_SETUP_TIMEOUT_MINUTES}m (includes cache, Node.js, Corepack and install)."
  echo "::notice::$message"
  echo "$message" >> "$GITHUB_STEP_SUMMARY"
else
  echo "Usage: dependency-setup-timing.sh start|report" >&2
  exit 1
fi
