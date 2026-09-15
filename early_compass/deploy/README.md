# Deploying Early Compass

Early Compass runs on the same EC2 box as the admin app, as its own Node service, under `/compass`.

| | Staging | Production |
|---|---|---|
| Portal | https://staging.brainastra.com/compass/ | https://www.brainastra.com/compass/ |
| API service | `early-compass-staging`, 127.0.0.1:8091 | `early-compass`, 127.0.0.1:8090 |
| Current release | `/home/ubuntu/early-compass-staging` → `releases/compass/<commit>` | `/home/ubuntu/early-compass` → `releases/compass/<commit>` |
| Settings | `/etc/early-compass/staging.env` | `/etc/early-compass/production.env` |
| DynamoDB | `EarlyCompass-dev-*` (shared with local development) | `EarlyCompass-production-*` |
| Report files | `s3://shichida-early-compass-dev-253264393609` | `s3://shichida-early-compass-production-253264393609` |
| Updated by | a push to `main` touching `early_compass/` | "Early Compass → production", run by a person |

The **portal** (the React app staff use) is built by the frontend repo's staging workflow into the
admin app's release as `compass/`, and promoted to production with "Frontend → production". The
**API** is released by this repo's two Early Compass workflows. Release the API first, then the
frontend.

---

## One-time setup (before the first push)

Nothing below has been done yet. Every step is needed once; the workflows fail until they are.

### 0. Memory

The box is a **t3.micro (911 MB, no swap)** already running both Django services, with about
330 MB free. Two Node services rendering PDFs will not fit reliably, and the kernel would kill
processes, possibly the production API. Before installing:

- **Resize to t3.small (2 GB)** and add 2 GB of swap. The instance has **no Elastic IP**, so
  stopping it changes its public IP: allocate and associate an Elastic IP first, then update the
  CloudFront origin (`ec2-15-206-125-114…`), the `staging.brainastra.com` DNS record and the
  `EC2_HOST` secret in both repos. Plan a 5–10 minute window.
- Grow the root volume from 8 GB (2.8 GB free) to 20 GB: each release keeps its own
  `node_modules`, and five are kept.

### 1. AWS

```bash
export AWS_PROFILE=shichida-setup AWS_REGION=ap-south-1
ACCOUNT=253264393609

# Production bucket (the dev bucket already exists): private, encrypted
B=shichida-early-compass-production-$ACCOUNT
aws s3api create-bucket --bucket $B --create-bucket-configuration LocationConstraint=ap-south-1 --object-ownership BucketOwnerEnforced
aws s3api put-public-access-block --bucket $B --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket $B --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-bucket-versioning --bucket $B --versioning-configuration Status=Enabled

# One IAM user per environment, allowed only its own tables, bucket and SES sending
for ENV in staging production; do
  aws iam create-user --user-name early-compass-$ENV
  aws iam put-user-policy --user-name early-compass-$ENV --policy-name early-compass-$ENV \
    --policy-document file://early_compass/deploy/iam-policy-$ENV.json
  aws iam create-access-key --user-name early-compass-$ENV   # goes into that environment's env file
done
```

The production tables are created by the first production release (`db:setup`), with
point-in-time recovery turned on.

### 2. CloudFront (www.brainastra.com)

The distribution `E2EAKEDECULDQN` forwards only the `Authorization`, `Origin`, `Host` and
`Content-Type` headers. Early Compass rejects every write without `X-Requested-With`, so sign-in
would fail. Add a behaviour **above** the default one:

- Path pattern `/compass*`, origin `ec2-origin`, redirect HTTP to HTTPS
- Allowed methods: GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE
- Legacy cache settings: headers `Host`, `Origin`, `Content-Type`, `X-Requested-With`; all
  cookies; all query strings; minimum, default and maximum TTL all 0

The default behaviour stays as it is. Staging isn't behind CloudFront.

### 3. The server

```bash
ssh -i ~/.ssh/shichida-ec2 ubuntu@<EC2_HOST>

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v

# Settings: copy deploy/staging.env.example and deploy/production.env.example, fill in
# APP_SECRET (openssl rand -base64 48, different for each) and each IAM user's keys
sudo mkdir -p /etc/early-compass
sudo nano /etc/early-compass/staging.env
sudo nano /etc/early-compass/production.env
sudo chmod 600 /etc/early-compass/*.env

# Services (copy deploy/early-compass*.service to the server first)
sudo cp early-compass.service early-compass-staging.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable early-compass early-compass-staging
mkdir -p /home/ubuntu/releases/compass

# nginx: paste deploy/nginx-compass.conf into both server blocks
# (8091 in the proxy_pass lines for staging), then:
sudo nano /etc/nginx/sites-available/staging
sudo nano /etc/nginx/sites-available/shichida
sudo nginx -t && sudo systemctl reload nginx
```

The services start once the first release exists (the workflows create the symlinks).

---

## Releasing

1. Merge to `main` → **Early Compass → staging** (this repo) and **Frontend → staging** (frontend
   repo) run. Try it on https://staging.brainastra.com/compass/.
2. Actions → **Early Compass → production** → Run workflow (commit empty = what staging runs).
3. Actions → **Frontend → production** → Run workflow.

Roll back by running the production workflow with an older commit (`ls -t ~/releases/compass`).

## Workshop accounts

Accounts are per table set. Local development and staging share `EarlyCompass-dev-*`, so an
account created locally already works on staging. For production, on the server:

```bash
sudo systemd-run --wait --pipe --collect -p User=ubuntu \
  -p WorkingDirectory=/home/ubuntu/early-compass \
  -p EnvironmentFile=/etc/early-compass/production.env \
  /usr/bin/node dist/scripts/create-user.js --email person@example.org --name "Workshop Lead" --role staff
```

It prints a generated password. Add `--reset` to set a new one. Staff can see and record every
child; only admins can erase records, edit the checklist and manage accounts.

## Checking

```bash
curl -s http://127.0.0.1:8091/compass/healthz            # on the server: staging
curl -s https://www.brainastra.com/compass/healthz        # production, through CloudFront
sudo journalctl -u early-compass --since "10 minutes ago" --no-pager
cat ~/releases/compass-staging.sha ~/releases/compass-production.sha
```
