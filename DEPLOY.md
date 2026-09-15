# Deploying

One EC2 box runs both environments. Merging to `main` updates **staging only**.
Production changes only when someone releases it by hand from GitHub.

| | Staging | Production |
|---|---|---|
| Site | https://staging.brainastra.com | https://www.brainastra.com (CloudFront) |
| Backend | `~/shichida_backend_staging`, service `shichida-staging`, port 8001 | `~/shichida_backend`, service `shichida`, port 8000 |
| Frontend | `/var/www/shichida-admin-staging` | `/var/www/shichida-admin` |
| Data | DynamoDB `Shichida-dev-*` (shared with local development) | DynamoDB `Shichida-production-*` |
| Updated by | every push to `main`, automatically | "Run workflow", by a person |

Host: `ubuntu@15.206.125.114` (`ssh -i ~/.ssh/shichida-ec2`).

---

## 1. Before merging

```bash
# Backend
./venv/bin/python manage.py test          # expect: OK

# Frontend
npm run lint                              # expect: no output
npm test                                  # expect: all passing
```

**`npm run lint` is the gate for the frontend.** `npm run build` runs `tsc -b`
first, so a typecheck error produces no bundle at all. The staging workflow
runs lint and tests too and stops on a failure, but finding out before you
merge is cheaper.

---

## 2. Merge → staging (automatic)

Each repo has a **"… → staging"** workflow that runs on every push to `main`:

- **Frontend → staging**: typecheck, test, build, keep the build in
  `/home/ubuntu/releases/frontend/<commit>`, then swap it into the staging
  folder and check staging serves it.
- **Backend → staging**: run the tests, move the staging checkout to the
  commit, install requirements, create any missing tables, restart
  `shichida-staging`, and check the API answers.

Watch them under the repo's **Actions** tab. Then try the change on
https://staging.brainastra.com. Staging uses the dev tables, so it is safe to
create and delete things there.

---

## 3. Staging → production (manual)

Release the backend first, then the frontend, so new screens never call an API
that isn't live yet.

1. GitHub → **schindia_backend** → Actions → **Backend → production** →
   **Run workflow**. Leave *commit* empty to release what staging runs.
2. Wait for it to go green.
3. GitHub → **Shichida** → Actions → **Frontend → production** →
   **Run workflow**, *commit* empty.

What they do:

- **Backend → production** moves `~/shichida_backend` to the commit, installs
  requirements, creates missing tables, restarts `shichida`, and checks the
  API. If the API does not come back, it puts the previous commit back on its
  own and the run fails.
- **Frontend → production** copies the exact build that was on staging — not
  a rebuild — into place, and puts the previous build back if production does
  not serve the new one.

Each release is recorded in `/home/ubuntu/releases/*-production.log` with the
commit and who ran it. Anyone with write access to a repo can run these.

---

## 4. Verify production

```bash
cd schindia_backend
./smoke-production.sh                     # expect: 17 passed, 0 failed
```

```bash
ssh -i ~/.ssh/shichida-ec2 ubuntu@15.206.125.114 '
  cat ~/releases/frontend-staging.sha ~/releases/frontend-production.sha
  curl -s -H "Host: www.brainastra.com" http://127.0.0.1/ | grep -oE "assets/index-[^\"]+\.js"
  sudo journalctl -u shichida --since "10 minutes ago" -p err --no-pager'
```

---

## 5. Rolling back

Run the same production workflow and type the older commit into *commit*.

- **Backend**: any commit on `main`.
- **Frontend**: one of the last ten builds kept on the server —
  `ls -t /home/ubuntu/releases/frontend` lists them, newest first.

Don't roll back by hand on the server: the workflows keep
`/home/ubuntu/releases/*.sha` in step with what is live, and the next release
reads them.

---

## Things that will bite you

**The frontend has no API address baked in.** Production builds always call
the site they are served from (`src/lib/apiBase.ts`), which is what lets one
build serve staging and production. `VITE_INVOICES_API_URL` only affects
`npm run dev`. Don't add it back to a production build or to the workflow.

**Staging's folder contains a production `.env`.** The `shichida-staging`
service reads `.env.staging`, but a plain `manage.py` in
`~/shichida_backend_staging` reads `.env` and talks to **production** tables.
Run commands there with the service's settings:

```bash
sudo systemd-run --wait --pipe --collect -p User=ubuntu \
  -p WorkingDirectory=/home/ubuntu/shichida_backend_staging \
  -p EnvironmentFile=/home/ubuntu/shichida_backend_staging/.env.staging \
  /home/ubuntu/shichida_backend_staging/venv/bin/python manage.py <command>
```

**Backend tests don't block staging yet.** About 46 tests reach the real
DynamoDB instead of a mock, so they fail on GitHub, which has no AWS
credentials. They pass locally only because your `.env` has real keys, and
there they read and write the dev tables. The workflow runs the suite and
shows the result but deploys anyway. Once those tests use a mock, remove
`continue-on-error` in `.github/workflows/deploy-staging.yml`.

**New indexes are not automatic.** Deploys run `create_dynamo_tables`, which
creates missing *tables* but never adds a GSI to a table that already exists.
That needs `update_table`, one index at a time, in both environments. A
missing index does not fail loudly; the screen that queries it just errors.
Attendance was broken in production this way for days.

**Production secrets live in the systemd unit,** not in `.env`:
`/etc/systemd/system/shichida.service`. python-decouple reads the environment
before `.env`, so the unit always wins for the running service. Values
containing spaces must be quoted, or systemd truncates at the first space.

**CloudFront usually needs no invalidation**: it fetches from the server on
each release. If a stale build persists, invalidate from the console; the
deploy IAM user has no CloudFront permissions.

---

## Early Compass (/compass)

A separate Node service in `early_compass/`, with its own workflows ("Early Compass → staging" /
"Early Compass → production"), tables (`EarlyCompass-*`) and settings. Its one-time server setup
and runbook: [early_compass/deploy/README.md](early_compass/deploy/README.md).
