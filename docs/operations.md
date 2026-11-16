# Operations

Everything here that mentions macOS is **written but not yet verified on the Mac mini**. Read
each command before running it.

## Install

```bash
# Recommended location: outside anything OpenClaw manages
mkdir -p ~/dev && cd ~/dev
# put the repository here (git clone, or unzip), then:
cd homepilot
node --version          # must be 22.13 or newer
npm install
npm run check           # typecheck and tests
cp .env.example .env    # then edit: at least HOMEPILOT_TIMEZONE
npm run build
./bin/homepilot init
./bin/homepilot health
```

## Step 0 on the Mac: the read-only audit

```bash
bash scripts/audit-openclaw.sh
```

It prints tool versions, asks OpenClaw for its status, and lists file names in `~/.openclaw`. It
changes nothing, opens no config or credential file, and writes one report to
`data/openclaw-audit-<date>.md` (git-ignored). Read the report before sharing it.

## Secrets

Preferred, on macOS (the command prompts for the value):

```bash
security add-generic-password -U -s homepilot -a OPENROUTER_API_KEY -w
security add-generic-password -U -s homepilot -a HOMEPILOT_API_TOKEN -w
```

Remove one: `security delete-generic-password -s homepilot -a OPENROUTER_API_KEY`

Alternative: put the value in `.env` and run `chmod 600 .env`.

A background service started by launchd may be asked by macOS to confirm Keychain access the
first time. If that prompt cannot be answered (headless Mac), use `.env` for the service.

## Running the scheduler

By hand: `./bin/homepilot run` (Ctrl+C stops it cleanly).

As a service that starts at login and restarts if it exits:

```bash
mkdir -p logs
sed -e "s|__NODE__|$(command -v node)|g" -e "s|__REPO__|$(pwd)|g" \
  scripts/launchd/com.homepilot.scheduler.plist.template \
  > ~/Library/LaunchAgents/com.homepilot.scheduler.plist
plutil -lint ~/Library/LaunchAgents/com.homepilot.scheduler.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.homepilot.scheduler.plist
launchctl print gui/$(id -u)/com.homepilot.scheduler | head -20
```

Stop and remove it:

```bash
launchctl bootout gui/$(id -u)/com.homepilot.scheduler
rm ~/Library/LaunchAgents/com.homepilot.scheduler.plist
```

Run only one scheduler at a time. Two would not send duplicates (jobs are claimed atomically),
but there is no reason to.

A LaunchAgent runs only while you are logged in. For a Mac mini that reboots unattended, enable
automatic login for that user, or convert this to a LaunchDaemon later. And a sleeping Mac sends
nothing: set the mini never to sleep (System Settings, Energy).

## Dashboard

```bash
./bin/homepilot serve
# open http://127.0.0.1:8787/?token=<your HOMEPILOT_API_TOKEN>
```

Loopback only. To view it from another device, use an SSH tunnel
(`ssh -L 8787:127.0.0.1:8787 you@mac-mini`). Do not expose the port.

## Kill switch

```bash
./bin/homepilot pause     # stops all deliveries and tool executions now
./bin/homepilot resume
```

Held reminders are delivered once after resume.

## Backup and restore

```bash
./bin/homepilot backup                 # writes data/backups/homepilot-<timestamp>.db
./bin/homepilot backup /Volumes/Backup/homepilot
```

The copy is consistent even while the scheduler is running.

Restore:

```bash
launchctl bootout gui/$(id -u)/com.homepilot.scheduler   # or stop `homepilot run`
cp data/homepilot.db data/homepilot.db.before-restore
rm -f data/homepilot.db-wal data/homepilot.db-shm
cp data/backups/homepilot-<timestamp>.db data/homepilot.db
./bin/homepilot health
```

Backups contain your task titles and notification text. They contain no API keys.

## Upgrading

```bash
./bin/homepilot backup
git pull            # or unpack the new version over the old one
npm install && npm run check && npm run build
./bin/homepilot init     # applies any new migrations; safe to run repeatedly
```

Migrations only move forward. To go back, restore the backup taken before upgrading.

## Health and logs

- `./bin/homepilot health` exits non-zero when something needs attention: a job that failed
  permanently, a notification that could not be delivered, or jobs more than 10 minutes overdue
  (which usually means the scheduler is not running).
- `./bin/homepilot events` is the audit trail. `./bin/homepilot jobs` is the queue.
- The service logs to `logs/scheduler.out.log` and `logs/scheduler.err.log`. They are not
  rotated yet; a rotation rule is a later item.

## Going from dry-run to live

1. Keep `HOMEPILOT_DRY_RUN=true`. Add the OpenRouter key and set
   `HOMEPILOT_MODEL_PROVIDER=openrouter`. Model calls become real; everything else stays mocked.
2. Send a message the parser does not know and check `./bin/homepilot usage`.
3. Only after a real notification channel exists (Phase 2) does `HOMEPILOT_DRY_RUN=false` do
   anything useful. Today no live channel is implemented, so leave it on.

## Uninstall, leaving OpenClaw untouched

```bash
launchctl bootout gui/$(id -u)/com.homepilot.scheduler 2>/dev/null
rm -f ~/Library/LaunchAgents/com.homepilot.scheduler.plist
security delete-generic-password -s homepilot -a OPENROUTER_API_KEY 2>/dev/null
security delete-generic-password -s homepilot -a HOMEPILOT_API_TOKEN 2>/dev/null
# if the skill was ever installed (it is not, by default):
#   rm -r ~/.openclaw/workspace/skills/homepilot
rm -rf ~/dev/homepilot
```

Then revoke the HomePilot key at https://openrouter.ai/keys. HomePilot writes nowhere else.
