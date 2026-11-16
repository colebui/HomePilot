#!/usr/bin/env bash
# HomePilot Phase 0: READ-ONLY audit of the Mac mini and its OpenClaw install.
#
# What it does:  prints OS and tool versions, asks OpenClaw for its own status, and lists the
#                NAMES of files in ~/.openclaw.
# What it never does: write outside the report file, change any setting, restart anything,
#                read the contents of any config or credential file, or print a secret.
#
# The openclaw subcommands used here (status, health, skills list, config get) were taken from
# docs.openclaw.ai on 2026-11-16. They have NOT been run against your installed version, so any
# of them may fail; a failure is recorded in the report and the script carries on.
#
# Usage:  bash scripts/audit-openclaw.sh            (run it ON the Mac mini)
# Output: data/openclaw-audit-<date>.md             (data/ is git-ignored)

set -u
cd "$(dirname "$0")/.."
mkdir -p data
OUT="data/openclaw-audit-$(date +%Y-%m-%d).md"
: > "$OUT"

say()  { printf '%s\n' "$*" | tee -a "$OUT"; }
# Run a command with a timeout-ish guard, capture output, never abort the script.
run()  {
  say ""
  say "### \`$*\`"
  say '```'
  if command -v "$1" >/dev/null 2>&1; then
    # Redact anything that looks like a key or token, in case a tool prints one.
    "$@" 2>&1 | head -n 80 | sed -E 's/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/\1…REDACTED/g; s/((api[_-]?key|token|secret|password)["'"'"' :=]+)[^ ,"'"'"']+/\1REDACTED/Ig' | tee -a "$OUT"
    say "(exit status: ${PIPESTATUS[0]})"
  else
    say "NOT FOUND: $1 is not on PATH"
  fi
  say '```'
}

say "# OpenClaw / host audit (read-only)"
say ""
say "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ) on host \`$(hostname -s 2>/dev/null || echo unknown)\`"

say ""
say "## 1. Host"
if [ "$(uname -s)" != "Darwin" ]; then
  say ""
  say "**WARNING: this is not macOS ($(uname -s)). This is probably not the Mac mini.**"
fi
run uname -srm
run sw_vers
run sysctl -n machdep.cpu.brand_string
run sysctl -n hw.memsize
run csrutil status
say ""
say "Shell: \`${SHELL:-unknown}\`"

say ""
say "## 2. Tooling"
run node --version
run npm --version
run git --version
run sqlite3 --version

say ""
say "## 3. OpenClaw"
say ""
say "Path: \`$(command -v openclaw 2>/dev/null || echo 'not on PATH')\`"
run openclaw --version
run openclaw status
run openclaw health
run openclaw skills list
run openclaw config get agents.defaults.workspace
run openclaw config get channels.imessage.cliPath

say ""
say "## 4. iMessage tooling"
say ""
say "imsg path: \`$(command -v imsg 2>/dev/null || echo 'not on PATH')\`"
run imsg --version

say ""
say "## 5. ~/.openclaw (file NAMES only; no file is opened)"
say '```'
if [ -d "$HOME/.openclaw" ]; then
  # Names, sizes and dates only, two levels deep. Contents are never read.
  (cd "$HOME/.openclaw" && find . -maxdepth 2 -not -name '.DS_Store' 2>/dev/null | head -n 200 | sort) | tee -a "$OUT"
else
  say "~/.openclaw does not exist"
fi
say '```'

say ""
say "## 6. Things this script cannot check (please answer by hand)"
say ""
say "- Is Messages.app signed in to the Apple ID that should receive HomePilot texts?"
say "- Which phone number or email should be the ONLY identity allowed to command HomePilot?"
say "- Does the OpenClaw agent have an unrestricted shell (exec) tool? This matters for security."
say "- Which model provider and default model is OpenClaw using today? (Do not paste keys.)"
say "- Is the OpenClaw iMessage private API enabled, and did enabling it require changing SIP?"
say ""
say "Report written to $OUT. Review it before sharing: it should contain no secrets, but check."
