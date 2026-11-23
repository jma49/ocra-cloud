# Remote runners

A hosted review clones a repository and runs the `ocra` CLI on it, which a Cloudflare Worker cannot do. A remote runner is a machine that does it for the server: it asks for the next queued job, runs it, and reports how it went. It only calls out over HTTPS, so it needs no public address, and any always-on machine with Node and git will do.

The server keeps everything that matters: the queue, the bot's credentials, each account's model key and budget. A runner holds one secret, its runner token. Each job brings what its run needs and nothing more: a bot token for that one repository, and a session of the account that enrolled it, both ended with the job. The review's model calls go through the server's gateway, so the runner never sees a model key.

## The server

Hosted reviews are on when the server has a runner token and a bot on at least one platform:

| Variable | Meaning |
|---|---|
| `RUNNER_TOKEN` | what runners prove themselves with: `openssl rand -base64 32`, at least 32 characters. Always needed |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | for GitHub: the GitHub App's number and private key, which mint the ocra bot's token per job ([self-hosting.md](self-hosting.md), A GitHub App of your own) |
| `GITHUB_WEBHOOK_SECRET` | for GitHub: the App's webhook secret; the App's webhook URL is `<PUBLIC_URL>/api/webhooks/github` |
| `GITLAB_BOT_TOKEN` | for GitLab: the bot account's token (scope `api`), which each GitLab job is given ([gitlab.md](gitlab.md), Bot). GitLab's project hooks are proven by each enrolled project's own secret, so GitLab needs no server-wide webhook secret |

A server that only uses GitLab sets `RUNNER_TOKEN` and `GITLAB_BOT_TOKEN` (with `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` and `GITLAB_URL`, which make GitLab a platform at all) and no GitHub App; without `GITLAB_BOT_TOKEN` it reviews the projects given their own access token ([gitlab.md](gitlab.md), Without a server-wide bot), and a job is given only its own project's token. A server with both reviews both; on the Worker, GitHub counts only with all three of its variables. A job for a platform the server has no bot for is refused (`no_bot`) rather than run.

On Workers the keys, the secrets and the tokens are secrets (`wrangler secret put`, with no trailing newline in piped input) and the App's number a variable. A self-hosted server reads them from its environment; with `AUTO_REVIEW_WORKERS=0` it leaves every job to its runners, otherwise it runs jobs itself as well.

Auto review in the console then lists each runner with when it last asked for work. A review queued while no runner is online waits for one. A job of an account that has used its gateway calls for the day (`GATEWAY_DAILY_CALLS`, or the account's own budget) also waits, until the count starts again at midnight UTC, and a review the limit cut short runs again then; Auto review says so while it lasts.

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
| `OCRA_RUNNER_POLL_SECONDS` | no | how long it waits before asking again when there was no job; 5 when unset. A job waits half of it on average before it starts, and every ask is one request to the server (about 17,000 a day at 5), so raise it where requests are counted against a plan |

It writes one JSON line per event to its output (`runner_started`, `runner_job_started`, `runner_job_ended`, `runner_failed`), never a token or a job's content. On `SIGTERM` it ends the job it is running, reports it failed so that the server queues it again, and exits. A server it cannot reach is asked again later, up to five minutes apart. Each job runs in a new temporary directory that is removed on every exit path.

Several runners may share one token; each job goes to one of them. A job whose runner disappears is queued again when its lease lapses (45 minutes for a review), or fails once it has had three runs.

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

## Code graphs

On Workers the server cannot build a code graph (a build clones nothing there and parsing one costs more CPU than a request has), so runners do. A runner says at hello that it builds graphs, and a claim with no review due may answer a graph build instead: the runner clones the repository without a checkout as the bot, reads the branch's tree and blobs with git (`ls-tree`, `cat-file`; nothing from the repository runs, and git's home is the job's own directory, never the clone), updates the repository's newest graph with only the files that changed, and uploads it gzipped. A build takes seconds.

A review's job names the account's graph of the reviewed repository when there is one. The runner then updates that graph to the pull request's base in its clone, hands it to the CLI (`ocra review --graph`), and after a review that ended well works out what the pull request reaches and uploads it; the review's page shows that in its Impact rail. Under `CODE_GRAPH` unset, a repository's first hosted review adds it to the account's Code graphs and queues its first build, so the next review has a graph.

The server stores each graph in its database as pieces of gzipped text (a D1 value holds at most 2 MB). On Workers it keeps one graph per repository, at most 5 repositories per account and 8 MB gzipped per graph (`too_large` beyond it); `CODE_GRAPH=off` (a variable) builds and keeps none. A build's failure is named on the Code graphs page: `no_bot` (the GitHub App is not installed on the repository), `clone_failed`, `too_large`, `build_failed`.

## Limits of this first version

- On Workers, pre-merge checks are evaluated when a review runs, not when a pull request's title or description is edited.
- On Workers a pull request's impact exists once ocra has reviewed it there; a GitLab project a review added has no push hook, so its graph is brought up to date at each review or by Rebuild.
- A runner is the deployment's, not an account's: every runner may be given any account's job.
