# BankJobz

A job board for every kind of job at banks and credit unions: branch, lending, commercial, operations, risk and compliance, finance, wealth, technology, data and leadership. Employers pay **$99 per posting, per month**.

## What it does

**Job seekers**
- Landing page, then **View current positions**: search, filter by specialty, institution type and on-site/hybrid/remote.
- Every job has a real, shareable URL (`/jobs/123`) with its own page title and link preview.
- Apply with name, email, phone, LinkedIn, a **résumé upload** (PDF or Word, up to 5 MB, checked to be a real document) and a note. They get a confirmation email.
- Sourced listings send them to the original posting.
- **Weekly job alerts** by specialty, with email confirmation and one-click unsubscribe.

**Employers**
- **Post a job**: fill in the role, pay $99 through Stripe Checkout, and it goes live as a Direct listing above sourced jobs.
- Each posting is its own monthly subscription. **Cancel posting** stops renewal (it stays up through the paid month); **Keep renewing** undoes it.
- Email when a posting goes live and for **every new applicant** (reply goes straight to the candidate).
- **Dashboard**: postings with billing status, applicant counts, **edit posting**, applicants with **résumé download**, **stages** (New, Reviewing, Interview, Offer, Hired, Not a fit), filter by posting, and **Cards & invoices** (Stripe's billing portal).
- Sign in on any device with **Email me a sign-in link** (single use, 30 minutes) or the posting key.

**You (site owner)** — `/#admin`
- Monthly recurring revenue, paid postings live, unpaid starts, sourced listings, employers, applications this week, alert subscribers.
- Take down any listing (a paid one also has its billing cancelled), reopen sourced ones, **add sourced listings** by hand, run the link check on demand.

**Automatic**
- **Google for Jobs**: employer postings carry schema.org `JobPosting` data; `/sitemap.xml` and `/robots.txt` are generated. Sourced listings are marked noindex since they duplicate someone else's posting.
- **Daily**: closes expired listings, and sourced listings whose original posting returns 404/410.
- **Weekly (Mondays 8 a.m. Central)**: job alert emails.
- Spam protection: hidden honeypot field on every public form; duplicate applications are caught.

## Stack

Static front end + Netlify Functions (Node 20+), Neon Postgres, Stripe, Resend for email, Netlify Blobs for résumés.

```
public/                  index.html, app.js, app.css, seed-jobs.json (25 real listings)
netlify/functions/       jobs, apply, checkout, session, stripe-webhook, employer, auth, alerts,
                         admin, job-page (/jobs/:id), sitemap, alerts-digest (weekly), daily-maintenance
netlify/lib/             shared (db, Stripe, validation), email, files (résumés), tasks (digest, link check)
db/schema.sql            employers, jobs, applications, alert_subscriptions (safe to re-run; upgrades older DBs)
scripts/seed.mjs         creates the schema and loads the 25 seed jobs
tests/                   e2e.mjs (81 API checks), browser.mjs (31 checks in real Chromium), fake Stripe, local server
```

## Updating an existing database

If your Neon database was set up before the switch to departments, paste `db/migrate-all-bank-jobs.sql` into the Neon SQL Editor and click Run. It is safe to run more than once.

## Launch checklist

1. **Neon**: create a project; copy the pooled connection string.
2. **Stripe** (test mode first):
   - Product "Job posting" with a **recurring $99.00/month** price → copy the `price_…` ID.
   - Settings → Billing → **Customer portal**: turn it on (cards, invoices, cancel).
3. **Resend**: add and verify your domain, create an API key. `EMAIL_FROM` must use that domain.
4. **Seed the database** from your computer:
   ```bash
   npm install
   cp .env.example .env    # fill it in
   export $(grep -v '^#' .env | xargs) && npm run db:seed
   ```
5. **Netlify**: push to GitHub, import the repo (no build command, publish dir `public`). Add every variable from `.env.example` under Site settings → Environment variables.
6. **Stripe webhook**: Developers → Webhooks → add `https://YOUR-SITE/api/stripe-webhook` with
   `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.
   Put its signing secret in `STRIPE_WEBHOOK_SECRET` and redeploy.
7. **Try it with a test card** (`4242 4242 4242 4242`): post a job, apply to it from another browser with a PDF, check both inboxes, open `/#admin`.
8. **Go live**: switch Stripe to live keys and a live $99 price, update the three Stripe variables, redeploy. Submit `https://YOUR-SITE/sitemap.xml` in Google Search Console.

## Running locally

```bash
npm run dev               # Netlify CLI at http://localhost:8888 (functions, Blobs and env vars included)
npm run stripe:listen     # second terminal; prints a whsec_ secret for .env
```

## Tests

Both suites run the real function code against a real Postgres database, with a small fake of the Stripe API (the real Stripe library talks to it, and webhooks go through Stripe's real signature check).

```bash
# Postgres on localhost (e.g. docker run -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16)
export TEST_DATABASE_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres
npm run test:e2e          # 81 checks: posting, payment, renewals, sign-in, applying, résumés, privacy, alerts, SEO, admin
npx playwright install chromium
npm run test:browser      # 31 checks clicking through the real pages, desktop and phone; screenshots in tests/screenshots
```

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/jobs?q=&category=&work_mode=&institution_type=` | open jobs, Direct first |
| GET | `/api/jobs/:id` | one job |
| POST | `/api/apply` | multipart: `job_id, name, email, phone?, linkedin_url?, cover_note?, resume` (file) |
| POST | `/api/alerts` | `{ email, categories[] }`; GET `/api/alerts/confirm?token=`, `/api/alerts/unsubscribe?token=` |
| POST | `/api/checkout` | job fields (+ `company, email, institution_type` when not signed in) → `{ url }` |
| GET | `/api/session?session_id=` | after Stripe → `{ company, token, job }` |
| POST | `/api/stripe-webhook` | Stripe only |
| POST | `/api/auth/request`, `/api/auth/verify` | emailed sign-in link |
| GET | `/api/employer` | Bearer key: postings, applicants |
| GET/PUT | `/api/employer/jobs/:id` | load / edit a posting |
| POST | `/api/employer/jobs/:id/pay` · `/cancel` · `/resume` | billing actions |
| POST | `/api/employer/applications/:id/status` | `{ status }` |
| GET | `/api/employer/applications/:id/resume` | download |
| POST | `/api/employer/billing` | Stripe billing portal |
| GET/POST | `/api/admin…` | Bearer `ADMIN_TOKEN` |
| GET | `/jobs/:id`, `/sitemap.xml`, `/robots.txt` | server-rendered for search engines |

## About the seed listings

25 real openings gathered in October 2026 from public job sites, each linking to its source. They expire after 30 days, and the daily link check closes any whose original page disappears. Add fresh ones from `/#admin`.

## Worth doing next

- **Automated sourcing**: a scheduled function pulling bank tech roles from public ATS feeds (Workday, Greenhouse, Lever career pages of target banks).
- **Featured upgrade** (e.g. +$49 to pin a posting to the top of the landing page).
- **Employer team seats** (several recruiters per bank).
