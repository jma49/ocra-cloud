# Remote runners

A hosted review clones a repository and runs the `ocra` CLI on it, which a Cloudflare Worker cannot do. A remote runner is a machine that does it for the server: it asks for the next queued job, runs it, and reports how it went. It only calls out over HTTPS, so it needs no public address, and any always-on machine with Node and git will do.

The server keeps everything that matters: the queue, the GitHub App's key, each account's model key and budget. A runner holds one secret, its runner token. Each job brings what its run needs and nothing more: a bot token for that one repository, and a session of the account that enrolled it, both ended with the job. The review's model calls go through the server's gateway, so the runner never sees a model key.

## The server

Hosted reviews are on when the server has all four of:

| Variable | Meaning |
|---|---|
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | the GitHub App's number and private key, which mint the ocra bot's token per job ([self-hosting.md](self-hosting.md), A GitHub App of your own) |
| `GITHUB_WEBHOOK_SECRET` | the App's webhook secret; the App's webhook URL is `<PUBLIC_URL>/api/webhooks/github` |
| `RUNNER_TOKEN` | what runners prove themselves with: `openssl rand -base64 32`, at least 32 characters |

On Workers the key, the secret and the token are secrets (`wrangler secret put`, with no trailing newline in piped input) and the App's number a variable. A self-hosted server reads them from its environment; with `AUTO_REVIEW_WORKERS=0` it leaves every job to its runners, otherwise it runs jobs itself as well.

Auto review in the console then lists each runner with when it last asked for work. A review queued while no runner is online waits for one.

## A runner

It needs Node 22.19 or later, git, and a checkout of this repository at the server's version:

```sh
npm ci
npm run build:runner
OCRA_CLOUD_URL=https://ocra.example.com OCRA_RUNNER_TOKEN_FILE=/path/to/runner-token node dist/runner.mjs
```

| Variable | Required | Meaning |
|---|---|---|
| `OCRA_CLOUD_URL` | yes | the server's address |
| `OCRA_RUNNER_TOKEN_FILE` | one of the two | a file holding the runner token, readable by the runner's user only |
| `OCRA_RUNNER_TOKEN` | one of the two | the token itself, where a file does not suit |
| `OCRA_RUNNER_NAME` | no | how the console names this runner; the machine's host name when unset |
| `OCRA_RUNNER_POLL_SECONDS` | no | how long it waits before asking again when there was no job; 20 when unset |

It writes one JSON line per event to its output (`runner_started`, `runner_job_started`, `runner_job_ended`, `runner_failed`), never a token or a job's content. On `SIGTERM` it ends the job it is running, reports it failed so that the server queues it again, and exits. A server it cannot reach is asked again later, up to five minutes apart. Each job runs in a new temporary directory that is removed on every exit path.

Several runners may share one token; each job goes to one of them. A job whose runner disappears is queued again when its lease lapses (45 minutes for a review).

### Kept running on macOS

A LaunchAgent starts the runner at login and restarts it when it exits. In `~/Library/LaunchAgents/com.ocra.runner.plist`, with the paths of your machine:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ocra.runner</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>/path/to/node</string><string>/path/to/ocra-cloud/dist/runner.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OCRA_CLOUD_URL</key><string>https://ocra.example.com</string>
    <key>OCRA_RUNNER_TOKEN_FILE</key><string>/path/to/runner-token</string>
    <key>PATH</key><string>/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/path/to/logs/runner.log</string>
  <key>StandardErrorPath</key><string>/path/to/logs/runner.log</string>
</dict>
</plist>
```

`caffeinate -is` keeps the machine awake while the runner runs (on mains power). Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ocra.runner.plist`. For it to start after a power cut with nobody at the keyboard, turn on automatic login and "Start up automatically after a power failure".

### Kept running on Linux

A systemd unit with `Restart=always`, `Environment=` lines for the variables above and `ExecStart=/usr/bin/node /opt/ocra-cloud/dist/runner.mjs` does the same.

## Limits of this first version

- On Workers, pre-merge checks are evaluated when a review runs, not when a pull request's title or description is edited.
- A runner is the deployment's, not an account's: every runner may be given any account's job.
