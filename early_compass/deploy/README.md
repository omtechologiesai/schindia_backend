# Deploying Early Compass

Early Compass runs on the same EC2 box as the admin app, as its own Node service, under `/compass`.

| | Staging | Production |
|---|---|---|
| Portal | https://staging.brainastra.com/compass/ | https://www.brainastra.com/compass/ |
| API service | `early-compass-staging`, 127.0.0.1:8091 | `early-compass`, 127.0.0.1:8090 |
| Current release | `/home/ubuntu/early-compass-staging` → `releases/compass/<commit>` | `/home/ubuntu/early-compass` → `releases/compass/<commit>` |
| Settings | `/etc/early-compass/staging.env` (root, 600) | `/etc/early-compass/production.env` (root, 600) |
| AWS identity | IAM user `early-compass-staging` | IAM user `early-compass-production` |
| DynamoDB | `EarlyCompass-dev-*` (shared with local development) | `EarlyCompass-production-*` (point-in-time recovery on) |
| Report files | `s3://shichida-early-compass-dev-253264393609` | `s3://shichida-early-compass-production-253264393609` (versioned) |
| Updated by | a push to `main` touching `early_compass/` | "Early Compass → production", run by a person |

Host: `ubuntu@13.234.196.14` (Elastic IP, `ssh -i ~/.ssh/shichida-ec2`).

The **portal** (the React app staff use) is built by the frontend repo's staging workflow into the
admin app's release as `compass/`, and promoted with "Frontend → production". The **API** is
released by this repo's two Early Compass workflows. Release the API first, then the frontend.

---

## Releasing

1. Merge to `main` → **Early Compass → staging** (this repo) and **Frontend → staging** (frontend
   repo) run. Try it on https://staging.brainastra.com/compass/.
2. Actions → **Early Compass → production** → Run workflow (commit empty = what staging runs).
3. Actions → **Frontend → production** → Run workflow.

Roll back by running the production workflow with an older commit (`ls -t ~/releases/compass`).
Don't switch the symlinks by hand: the workflows keep `~/releases/compass-*.sha` in step with what
is live.

## Workshop accounts

Accounts belong to a table set. Local development and staging share `EarlyCompass-dev-*`, so an
account created locally already works on staging. For production, on the server:

```bash
sudo systemd-run --wait --pipe --collect -p User=ubuntu \
  -p WorkingDirectory=/home/ubuntu/early-compass \
  -p EnvironmentFile=/etc/early-compass/production.env \
  /usr/bin/node dist/scripts/create-user.js --email person@example.org --name "Workshop Lead" --role staff
```

It prints a generated password; add `--reset` for a new one. Staff can see and record every child;
only admins can erase records, edit the checklist and manage accounts.

## Checking

```bash
# on the server
curl -s http://127.0.0.1:8091/compass/healthz          # staging API
curl -s http://127.0.0.1:8090/compass/healthz          # production API
sudo journalctl -u early-compass --since "10 minutes ago" --no-pager
cat ~/releases/compass-staging.sha ~/releases/compass-production.sha

# from anywhere
curl -s https://www.brainastra.com/compass/healthz
```

---

## How the server was set up (2026-09-15)

Done once; kept here to rebuild the box or check what's there.

**Instance.** Resized from t3.micro to **t3.small** (2 vCPU, 1.9 GB) with 2 GB of swap
(`/swapfile`, `vm.swappiness=10`). Root volume grown from 8 GB to 20 GB. Elastic IP
`13.234.196.14` (`eipalloc-0157ad9c415b1b7a2`) attached, replacing the auto-assigned
15.206.125.114. The snapshot taken before the resize is `snap-0635d8e40275615c5`.

**Network.** Security group `sg-0f5cdd55034b06c22` no longer opens port 8000: gunicorn is only
reached through nginx on 127.0.0.1. Inbound is 22, 80 and 443.

**CloudFront** `E2EAKEDECULDQN`: origin `ec2-13-234-196-14.ap-south-1.compute.amazonaws.com`, and a
`/compass*` behaviour identical to the default plus the `X-Requested-With` header (Early Compass
rejects writes without it; the default behaviour doesn't forward it). No caching.

**AWS.** Buckets (private, SSE-S3; production versioned). IAM users with the inline policies in
`iam-policy-staging.json` / `iam-policy-production.json`; their access keys exist only in the env
files. Tables are created and updated by `db-setup` on every release.

**Server.**

```bash
# Node 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs

# Settings: from staging.env.example / production.env.example, each with its own APP_SECRET
# (openssl rand -base64 48) and its IAM user's access key
sudo install -m 600 -o root -g root staging.env /etc/early-compass/staging.env

# Services (they stay skipped until a release exists)
sudo cp early-compass.service early-compass-staging.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable early-compass early-compass-staging

# nginx: nginx-compass.conf as /etc/nginx/snippets/early-compass-production.conf, and a copy with
# port 8091 as early-compass-staging.conf, each included in its site's server block
# ("include snippets/early-compass-….conf;" above "location /api/"). Backups of the site files
# from before the change are in /etc/nginx/backup/.
sudo nginx -t && sudo systemctl reload nginx
```
