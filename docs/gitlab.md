# ocra Cloud with a self-managed GitLab

A company runs ocra Cloud next to its own GitLab, with its own models and without any public service: people sign in with GitLab, the console works on their merge requests as them, and a bot reviews every merge request and answers `@ocra` in its threads. `test-node/gitlab-self-managed.test.ts` runs this whole path in CI against a stand-in instance with its own certificate authority and a relative URL root: sign-in, a hosted review, its pre-merge check from the issue the merge request closes, an `@ocra` answer, a finding's fix committed, a merge train joined and left, and a stack merged. The variables are in [self-hosting.md](self-hosting.md), Variables.

## 1. In GitLab (an administrator)

1. **Application.** Admin Area → Applications → New, confidential, with two redirect URIs, `<PUBLIC_URL>/api/auth/oidc/callback` and `<PUBLIC_URL>/api/platforms/gitlab/callback`, and the scopes `openid profile email api`. Set its id and secret as both `OIDC_CLIENT_ID`/`OIDC_CLIENT_SECRET` and `GITLAB_CLIENT_ID`/`GITLAB_CLIENT_SECRET`, and the instance's address (`https://gitlab.example.com`, or `https://example.com/gitlab` under a relative root) as both `OIDC_ISSUER` and `GITLAB_URL`; `OIDC_NAME=GitLab`. Signing in then connects GitLab in the same consent: the console comments, approves, merges and commits fixes as the person who uses it.
2. **Or two applications,** when people sign in with another SSO: the OIDC variables name that provider, and a GitLab application with the second redirect URI and scope `api` is connected once on the Repositories page.
3. **Bot.** A user for ocra (or a group or project access token, which gets a bot user of its own) with the Developer role on the projects it reviews, and a token with the `api` scope: `GITLAB_BOT_TOKEN`. It posts the reviews and answers, and the pre-merge check's commit status.
4. **Outbound requests.** Admin Area → Settings → Network → Outbound requests: allow requests to the local network, or add ocra's host to the allowlist, so that project hooks can reach it.

## 2. The company's models

Declare the internal OpenAI-compatible endpoint in `MODEL_ENDPOINTS`, with the server's own `key` so nobody needs one, set `BUILTIN_PROVIDERS=off` so no call leaves for a public provider, and name its models in `DEFAULT_MODELS` (self-hosting.md, Company models). Reviews then run on them from the first sign-in, through the server's gateway: the CLI that reviews gets a session to this server, never the model's key.

## 3. Certificates and proxy

When GitLab or the model endpoint has a certificate of the company's own authority, both Node and git must trust it. Add it to the image:

```dockerfile
FROM ocra-cloud
USER root
COPY company-ca.pem /usr/local/share/ca-certificates/company-ca.crt
RUN update-ca-certificates
USER node
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/company-ca.crt
```

`update-ca-certificates` is what git reads; `NODE_EXTRA_CA_CERTS` is what the server and the review CLI read. Outside this image, set `NODE_EXTRA_CA_CERTS` and `GIT_SSL_CAINFO` (a bundle that includes the company's authority) instead. Behind a proxy, set `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (with the GitLab and model hosts in `NO_PROXY` when they are inside). The server passes these variables, and nothing else of its environment, to git and the CLI of each review.

## 4. Start and enroll

1. Start the server (self-hosting.md, Run it) with `PUBLIC_URL` set: reviews sign in to it and GitLab's token refresh names it.
2. Each person signs in with GitLab (with two applications, they also connect GitLab once on the Repositories page).
3. Whoever owns a project's reviews enrolls it on the Auto review page. The answer gives the hook's address (`<PUBLIC_URL>/api/auto-review/webhooks/gitlab`) and a secret, shown once.
4. In the project, Settings → Webhooks: that address and secret token, with **Merge request events** and **Comments**. A merge request is reviewed when it opens, reopens, leaves draft or gains commits; a comment that mentions `@ocra` is answered in its thread.
5. For code graphs, a second hook to the address the Code graphs page gives, with **Push events**.

## What a review does

The server clones the project over HTTPS with the bot's token, under `GITLAB_URL` and its relative root, into a new directory; runs the bundled `ocra review --mr <iid> --publish --no-repo-config` there with the bot's token, the instance's API (`CI_API_V4_URL`) and a session to this server; and deletes the directory and the session afterwards. Nothing from the merge request runs. The review is posted as a summary note and a thread on each finding's line, and its counts are uploaded to the account that enrolled the project.

## Check it

- `GET /api/health` answers.
- Sign in with GitLab: a refusal names the step (`bad_state` for a redirect URI that does not match, `upstream_unreachable` for a discovery document, token or user that GitLab did not give, often a certificate the server does not trust).
- Open a merge request with a pre-merge check enrolled: its commit status `ocra / pre-merge` is pending ("Waiting for the review") until the review lands, then the result.
- Open a merge request: the Auto review page shows the job, and its error when a run failed (`clone_failed` is usually the bot's role or git's certificate; `review_failed` the model endpoint).

