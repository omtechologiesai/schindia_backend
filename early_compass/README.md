# Shichida India · Early Compass (API)

A portal for running the Early Compass developmental assessment at Shichida India workshops:
save it to the child's record, and send the parent a branded PDF report by email or WhatsApp.
It lives at **brainastra.com/compass**, separate from the admin app: its own sign-in, its own
DynamoDB tables, its own service.

This folder is the API. The staff portal (React) is in the frontend repo under `early-compass/`.

It is built from the **Shape Early Compass** HTML tool. Carried over unchanged:

- the same 480-item Shichida checklist, as the starting set of questions
- the scoring, age-based target, focus areas, activity ideas and growth commentary
- the attainment goals and the CDC/WHO/ASQ benchmarks
- the disclaimers

## What staff do

1. **Sign in** and choose **New assessment**. For an existing child, search for them to start a follow-up.
2. **Enter the details:** the child's name, date of birth, gender and centre, and the parent or guardian's name, relationship, mobile and email.
3. **Tick the milestones** the child can do. The checklist band (0–2, 2–4 or 4–6 years) is picked from the child's age, and a live compass updates as you tick.
4. **Optionally add goals, interests and notes.**
5. **Review and save.** The server stores the record and creates the A4 PDF report and a shareable chart snapshot.
6. **Share it** by email, WhatsApp or a private report link. Every send is logged against the record.

## Local development

Needs Node.js 22+. Uses the AWS dev resources (`EarlyCompass-dev-*` tables, the dev bucket and
SES) through the `shichida-setup` profile.

```bash
cp .env.example .env          # the defaults point at the dev resources
npm install
npm run dev                   # API on http://127.0.0.1:8090/compass (creates the dev tables if missing)
```

Then start the portal in the frontend repo (`early-compass/`: `npm run dev`) and open
http://localhost:5174/compass/. Create an account with:

```bash
npm run user:create -- --email priya@example.org --name "Priya Nair" --role admin
npm run user:create -- --email priya@example.org --reset      # new password
```

`EMAIL_MODE=ses` sends real emails. Use `EMAIL_MODE=preview` to save them as `.eml` files instead.

## Tests

```bash
mkdir -p .dynamodb && curl -sL https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz | tar xz -C .dynamodb
npm test
```

The API tests start DynamoDB Local in memory (Java 17+) and keep files on a temporary disk
directory; they never touch AWS. They cover algorithm parity with the original, date and phone
handling, and the whole flow through the HTTP API: sign-in → assessment → PDF and snapshot →
email preview → WhatsApp link → parent page → revoked link → corrected details → follow-up with
growth commentary → erasure → checklist edits.

## Deploying

See [deploy/README.md](deploy/README.md): staging on every push to `main` that touches this
folder, production by hand.

## Configuration

All settings are environment variables; `.env.example` documents each one.

| Variable | Purpose |
| --- | --- |
| `BASE_PATH` | Path on the shared site. Default `/compass`. |
| `PUBLIC_BASE_URL` | Site address (no path) used in links sent to parents. Required in production. |
| `APP_SECRET` | 32+ random characters that sign report links. Required in production. |
| `APP_ENV` | `dev` or `production`: which `EarlyCompass-<env>-*` tables to use. |
| `AWS_REGION`, `AWS_PROFILE` / `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | AWS access. |
| `S3_BUCKET`, `S3_PREFIX` | Report files and email previews. Required in production. |
| `EMAIL_MODE`, `MAIL_FROM`, `SES_CONFIGURATION_SET` | `preview`, `ses` or `smtp`, and the verified sender. |
| `TIME_ZONE`, `REPORT_LINK_DAYS`, `SESSION_HOURS`, `COOKIE_SECURE`, `TRUST_PROXY` | Dates, links, sessions, proxies. |
| `CENTRES`, `ORG_SUPPORT_*` | Centre names for the form; contact details shown to parents. |
| `WHATSAPP_*` | WhatsApp Business Cloud API (optional; click-to-chat without it). |
| `INTERNAL_WEBHOOK_URL`, `INTERNAL_WEBHOOK_SECRET` | Optional sync to an internal system. |

## How it is built

```
shared/   used by the API and, as a copy, by the portal (frontend repo early-compass/shared)
  data/        checklist (480 items), goals, CDC/WHO benchmarks, activities
  scoring.ts   the Early Compass algorithm
  compass.ts   chart geometry and SVG, one source for the web chart, PNG and PDF
  copy.ts      brand names and every disclaimer
  schemas.ts   validation shared by forms and API
server/   Express 5 API under /compass
  db.ts        DynamoDB tables and indexes, idempotent setup, checklist seeding
  repo.ts      data access
  storage.ts   report files on S3 (or local disk in development and tests)
  services/    report-pdf.tsx (react-pdf), chart.ts (resvg), email.ts (SES), whatsapp.ts, sync.ts, assessments.ts
  routes/      auth, assessments, children, users, meta, public report page (/compass/r/…)
scripts/  db-setup, create-user, sample-report
deploy/   systemd units, nginx snippet, env templates, IAM policies, runbook
```

**Change `shared/` here**, then copy it to the frontend repo:
`rsync -a --delete early_compass/shared/ ../Shichida/early-compass/shared/`.

**Data.** Seven on-demand DynamoDB tables per environment: Users, Sessions (expired sessions are
deleted by DynamoDB), Children, Assessments (indexed by child and by date), Deliveries, Checklist
and Meta (counters, unique-email guards). Saving an assessment writes the child and the assessment
in one transaction. Lists and searches filter in the process, which suits workshop scale (a few
thousand records); the by-date index carries only summary columns, so lists never read the answer
JSON.

**Reports** are rendered on the server without a headless browser: the PDF with
`@react-pdf/renderer` (real text in the embedded brand font), the chart and snapshot with
`@resvg/resvg-js`. On save the server recomputes everything from the submitted answers and stores
a snapshot of the question wording, the contact details and the results, so a report can be
regenerated identically. Files are versioned, so a regenerated report never overwrites the copy a
parent was sent.

**Security.**

- Staff accounts only, scrypt password hashes, login throttling.
- HTTP-only session cookie scoped to `/compass`, and a custom request header required on writes as CSRF protection.
- Report links signed with `APP_SECRET`; they expire, and revoking them rotates the signature.
- Private, encrypted S3 buckets; files reach parents only through the signed links.
- Administrators can erase a child and all of their files, e.g. on a parent's request.

## The assessment logic (unchanged from the original)

- **Band from age:** under 24 months → 0–2 years; under 48 → 2–4; otherwise 4–6. Staff can pick another band, and the report says it was chosen manually.
- **Scores:** each domain's score, and the overall score, is the share of that band's milestones observed.
- **Target for age:** `(age − band start) ÷ 24 months`, clamped to 5–100%. Staff can override it between 10% and 95%.
- **Focus areas:** domains more than 4 points below the target, largest gap first, each with three activities (matching interests first) and the next three unticked milestones.
- **Growth commentary:** compares with the child's previous assessment, but not across a band change.

Administrators can add or remove questions under **Reference → Milestone checklist**. Each change
adds a revision to the checklist version (e.g. `shichida-2016.1.r3`); saved assessments keep the
questions they were answered with.

## Disclaimers

Retained from the original and shown in the portal, the PDF, the email, the WhatsApp message and
the parent's report page: "not a diagnostic tool", "a reference tool, not a diagnostic
instrument", how to read the compass, and the CDC, WHO and ASQ-3 notes and sources. The original
line "Data is stored only on this device…" stopped being true once records are stored, so an
accurate data notice replaces it (`shared/copy.ts`).
