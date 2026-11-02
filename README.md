# BankJobz

A job board for every kind of job at banks and credit unions: branch, lending, commercial, operations, risk and compliance, finance, wealth, technology, data and leadership. Employers pay **$99 per posting, per month**.

## What it does

**Job seekers**
- **Profiles & one-click apply**: a free candidate profile (passwordless email sign-in, same as employers), with departments, location, work preference and a résumé on file.
- **Ranked matches**: the résumé's text is extracted at upload (PDF/DOCX) and every open job is scored against it — banking-domain phrases by department, word overlap weighted by rarity, plus the candidate's own picks. Each match shows a 0–98 score, a tier and the reasons. No outside AI services; deterministic and explainable (`netlify/lib/match.mjs`).
- **Quick apply**: one click sends the saved profile and a copy of the résumé — on job pages and straight from the matches list. Replacing the résumé later never changes past applications.
- **My profile hub**: one section with tabs — Profile, Matches, Saved jobs, Applications. **☆ Save** on any job page or match bookmarks a role; the Applications tab lists everything they've applied to, whether the posting is still open, and any talent-pool invites.
- **Banking-native profile**: core systems they've run (SilverLake, Episys, Fiserv DNA…) and licenses they hold (NMLS, CRCM, CAMS…), auto-detected from the résumé when left blank. Core-system and license matches are the top-ranked reasons in matching.
- **Talent pool (opt-in, anonymous)**: candidates can show an anonymous card — location, departments, systems, licenses, summary; never name, contact details or résumé — to employers with a live posting. A per-candidate block list hides them from named employers (their own bank, say). Employers invite them to a posting by email; identity is shared only if the candidate applies.
- Landing page, then **View current positions**: search, filter by specialty, institution type and on-site/hybrid/remote.
- Every job has a real, shareable URL (`/jobs/123`) with its own page title and link preview.
- Apply with name, email, phone, LinkedIn, a **résumé upload** (PDF or Word, up to 5 MB, checked to be a real document) and a note. They get a confirmation email.
- Sourced listings send them to the original posting.
- **Weekly job alerts** by specialty, with email confirmation and one-click unsubscribe.

**Employers**
- **Post a job**: fill in the role, pay $99 through Stripe Checkout, and it goes live as a Direct listing above sourced jobs. Optional banking specifics — the core system the role touches and licenses required — make the posting filterable and boost its match rank for the right candidates.
- **Talent pool** in the dashboard: browse opted-in candidates anonymously, filter by department, state, core system or license, and invite one to a posting with a note. Included with any live posting.
- Each posting is its own monthly subscription. **Cancel posting** stops renewal (it stays up through the paid month); **Keep renewing** undoes it.
- Email when a posting goes live and for **every new applicant** (reply goes straight to the candidate).
- **Dashboard**: postings with billing status, applicant counts, **edit posting**, applicants with **résumé download**, **stages** (New, Reviewing, Interview, Offer, Hired, Not a fit), filter by posting, and **Cards & invoices** (Stripe's billing portal).
- Sign in on any device with **Email me a sign-in link** (single use, 30 minutes) or the posting key.

**You (site owner)** — `/#admin`
- Monthly recurring revenue, paid postings live, unpaid starts, sourced listings, employers, applications this week, alert subscribers.
- Take down any listing (a paid one also has its billing cancelled), reopen sourced ones, **add sourced listings** by hand, run the link check on demand.

**Institution directory** — `/banks`
- Every active US bank (FDIC) and credit union (NCUA) gets its own server-rendered page — assets, branches, charter numbers from public data — showing its open jobs on the board, with state pages and a browsable index. ~8,500 indexable pages targeting "jobs at {bank name}" searches, all in the sitemap.
- Loaded and refreshed from `/#admin` → "Load the institution directory" (pages through the FDIC and NCUA APIs; a few minutes). Postings link to their institution's page automatically by name.
- Data sources: `api.fdic.gov/banks/institutions` (the BankFind API — note it moved off banks.data.fdic.gov) and NCUA's credit-union locator API at mapping.ncua.gov (100 rows per page; roster only, so CU asset figures stay empty until a richer source is wired). If NCUA's response shape has drifted, the admin sync reports the error and the FDIC half still completes.

**Automatic**
- **Google for Jobs**: employer postings carry schema.org `JobPosting` data; `/sitemap.xml` and `/robots.txt` are generated (including every directory page). Sourced listings are marked noindex since they duplicate someone else's posting.
- **Daily**: closes expired listings, and sourced listings whose original posting is gone — a hard 404/410, or a page that still loads but says the job is no longer available (how aggregators and most ATSes behave).
- **Weekly (Mondays 8 a.m. Central)**: job alert emails.
- Spam protection: hidden honeypot field on every public form; duplicate applications are caught.

## Stack

Static front end + Netlify Functions (Node 20+), Neon Postgres, Stripe, Resend for email, Netlify Blobs for résumés.

```
public/                  index.html, app.js, app.css, seed-jobs.json (64 real listings)
netlify/functions/       jobs, apply, checkout, session, stripe-webhook, employer (+talent pool), auth,
                         alerts, candidate, candidate-auth, admin, job-page (/jobs/:id),
                         institution-page (/banks/*), sitemap, alerts-digest (weekly), daily-maintenance
netlify/lib/             shared (db, Stripe, validation), banking (core systems, licenses, résumé detection),
                         institutions (FDIC/NCUA sync), match, email, files (résumés), extract, tasks
db/schema.sql            every table; safe to re-run — it upgrades older databases in place
scripts/seed.mjs         creates the schema and loads the seed jobs
tests/                   e2e.mjs (148 API checks), browser.mjs (44 checks in real Chromium),
                         fake Stripe, fake FDIC/NCUA, local server
```

## Updating an existing database

Paste the whole of `db/schema.sql` into the Neon SQL Editor and click Run — it creates anything missing and upgrades older databases in place, without touching data. Safe to run as often as you like. (The dated files in `db/` are one-off patches already folded into it.)

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
9. **Load the directory**: open `/#admin` and click "Load the institution directory". Resubmit the sitemap afterwards so Google finds the ~8,500 new institution pages.

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
npm run test:e2e          # 148 checks: posting, payment, renewals, sign-in, applying, résumés, saved jobs, filters, talent pool, directory, privacy, alerts, SEO, admin
npx playwright install chromium
npm run test:browser      # 44 checks clicking through the real pages, desktop and phone; screenshots in tests/screenshots
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
| POST | `/api/candidate-auth/request`, `/verify` | candidate sign-in links |
| GET/PUT | `/api/candidate` | Bearer ck_ token: profile + their applications |
| POST/GET | `/api/candidate/resume` | upload (extracts text) / download own résumé |
| GET | `/api/candidate/matches` | every open job ranked, with scores and reasons |
| POST | `/api/candidate/save` | bookmark `{ job_id, saved: true\|false }` |
| POST | `/api/candidate/apply` | one-click apply `{ job_id, cover_note? }` |
| GET | `/api/employer/talent?category=&state=&core_system=&license=` | anonymous talent pool (needs a live posting) |
| POST | `/api/employer/talent/:id/invite` | `{ job_id, note? }` → invite email to the candidate |
| POST | `/api/admin/institutions/sync` | `{ source: "fdic"\|"ncua", offset }` → one page of the directory |
| GET | `/banks`, `/banks/:state`, `/banks/:slug` | server-rendered institution directory |
| GET | `/api/employer` | Bearer key: postings, applicants |
| GET/PUT | `/api/employer/jobs/:id` | load / edit a posting |
| POST | `/api/employer/jobs/:id/pay` · `/cancel` · `/resume` | billing actions |
| POST | `/api/employer/applications/:id/status` | `{ status }` |
| GET | `/api/employer/applications/:id/resume` | download |
| POST | `/api/employer/billing` | Stripe billing portal |
| GET/POST | `/api/admin…` | Bearer `ADMIN_TOKEN` |
| GET | `/jobs/:id`, `/sitemap.xml`, `/robots.txt` | server-rendered for search engines |

## Legal pages and takedowns

- `/privacy.html` and `/terms.html` are linked from the footer. They're solid drafts written for this exact product, but have a lawyer review them before you advertise, and create the `listings@` and `privacy@` mailboxes on your domain (aliases to your inbox are fine).
- The footer states BankJobz isn't affiliated with the employers shown and gives employers a claim/correct/remove email. Honor removal requests the same day (admin → Take down).
- When adding sourced listings, prefer the bank's own careers/ATS page over copies on other job boards.

## About the seed listings

64 real openings across every department (branch, lending, commercial, operations, risk, finance, wealth, technology, data and leadership), gathered October-November 2026 from public job sites, each linking to its source. They expire after 30 days, and the daily link check closes any whose original page disappears. Add fresh ones from `/#admin`.

## Worth doing next

- **Automated sourcing**: a scheduled function pulling bank tech roles from public ATS feeds (Workday, Greenhouse, Lever career pages of target banks).
- **Featured upgrade** (e.g. +$49 to pin a posting to the top of the landing page).
- **Employer team seats** (several recruiters per bank).
