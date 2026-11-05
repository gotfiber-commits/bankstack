# BankJobz

A job board for every kind of job at banks and credit unions: branch, lending, commercial, operations, risk and compliance, finance, wealth, technology, data and leadership. Employers subscribe to a monthly **hiring plan**: **$99 for up to 5 live postings, $159.99 for up to 10**, and a set amount (chosen in the admin console) for each posting over 10.

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
- **Employer accounts with MFA**: hiring managers create a free account (name, title, institution, work email, password) and confirm their email with a 6-digit code. Every sign-in on a new device is **password + a second factor** — a 6-digit code by email, or from an authenticator app (Microsoft/Google Authenticator, 1Password) with 10 single-use recovery codes. "Trust this device for 30 days" skips the code on their own computer. Built-in protections: scrypt-hashed passwords, limits counted before every check (8 tries per network; email-wide ceilings of 40 passwords and 10 codes; 15-minute pause), with the owner emailed when a pause starts. Trusted devices and the one-click button in every code email keep working through a pause, so nobody can lock the owner out. Codes are limited to 5 tries and 10 minutes, hashed revocable sessions (30-day max, 14-day idle), security-notice emails on password/MFA changes, and forms that never reveal whether an email has an account. "Employer sign in" is always in the top nav.
- **Hiring dashboard** with tabs: **Overview** (live postings, applicants, last-7-days, job page views, monthly spend, a clickable hiring pipeline, recent applicants, and postings that need attention — unpaid, ending, or a week with no applicants); **Postings** (views, applicants, apply rate, edit, duplicate, cancel/keep renewing); **Applicants** (search, filter by posting and stage, sort by rating, 1–5 star ratings, private notes, résumé download, CSV export); **Talent pool**; **Account & security** (details, authenticator app setup by QR code, recovery codes, change password, every signed-in device with sign-out, forget trusted devices, applicant-email on/off).
- **Post a job**: the first posting starts the institution's hiring plan in Stripe Checkout; after that, postings go live instantly under the plan. A posting that moves the plan to a higher price asks first, then charges the prorated difference. Closing postings lowers the next bill (no mid-month refunds), and reopening or replacing within a paid month is free. Postings go live as Direct listings above sourced jobs. Optional banking specifics — the core system the role touches and licenses required — make the posting filterable and boost its match rank for the right candidates.
- **Talent pool** in the dashboard: browse opted-in candidates anonymously, filter by department, state, core system or license, and invite one to a posting with a note. Included with any live posting.
- Each posting is its own monthly subscription. **Cancel posting** stops renewal (it stays up through the paid month); **Keep renewing** undoes it.
- Email when a posting goes live and for **every new applicant** (reply goes straight to the candidate).
- **Dashboard**: postings with billing status, applicant counts, **edit posting**, applicants with **résumé download**, **stages** (New, Reviewing, Interview, Offer, Hired, Not a fit), filter by posting, and **Cards & invoices** (Stripe's billing portal).

**You (site owner)** — `/#admin`
- Monthly recurring revenue, paid postings live, unpaid starts, sourced listings, employers, applications this week, alert subscribers.
- Take down any listing (a paid one also has its billing cancelled), reopen sourced ones, **add sourced listings** by hand, run the link check on demand.

**AI writing assistant** (optional — appears once `ANTHROPIC_API_KEY` is set)
- **Employers**: "Let AI draft the summary and description" on the post and edit forms — builds a clean, EEO-safe posting from the fields plus rough notes, filled into the form for them to edit. Better postings, less friction to posting.
- **Candidates**: "Tailor my application" on any Direct job — a cover note and résumé-angle tips generated **only from what's actually in their résumé** (the prompt forbids inventing experience), prefilled and editable before one-click sending.
- Guardrails: per-person daily limit (`AI_DAILY_LIMIT`, default 20) logged in `ai_usage`; the whole feature hides when no key is set; drafts always pass through human hands. Costs run well under a cent per draft on Haiku-class models — set a spend cap in the Anthropic console.

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
tests/                   e2e.mjs (335 API checks), browser.mjs (94 checks in real Chromium),
                         fake Stripe, fake FDIC/NCUA, local server
```

## Updating an existing database

Paste the whole of `db/schema.sql` into the Neon SQL Editor and click Run — it creates anything missing and upgrades older databases in place, without touching data. Safe to run as often as you like. (The dated files in `db/` are one-off patches already folded into it.)

## Launch checklist

1. **Neon**: create a project; copy the pooled connection string.
2. **Stripe** (test mode first):
   - No product or price to create by hand: after deploying, open `/#admin` → **Billing setup**, enter the monthly price for each posting over 10, and click **Create the plan in Stripe**. It makes one graduated monthly price ($99 up to 5, $159.99 up to 10, + your amount each after).
   - Settings → Billing → **Customer portal**: turn it on for cards, invoices and cancelling. Leave **"Customers can switch plans" and "update quantities" off**, because the site sets the plan's quantity itself from the number of live postings.
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
8. **Go live**: switch Stripe to live keys, update `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, redeploy, then create the plan from `/#admin` → Billing setup in live mode. Submit `https://YOUR-SITE/sitemap.xml` in Google Search Console.
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
npm run test:e2e          # 335 checks: posting, hiring-plan billing (tiers, upgrades, closes, renewals, declines), sign-in, applying, résumés, saved jobs, filters, talent pool, directory, AI assist, privacy, alerts, SEO, admin
npx playwright install chromium
npm run test:browser      # 94 checks clicking through the real pages, desktop and phone; screenshots in tests/screenshots
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
| POST | `/api/auth/signup` | `{ contact_name, contact_title?, company, institution_type, email, password }` → `{ challenge }`, code emailed |
| POST | `/api/auth/login` | `{ email, password, device_token? }` → `{ token }` on a trusted device, else `{ challenge, method }` |
| POST | `/api/auth/verify` | `{ challenge, code, remember_device? }` → `{ token, device_token? }` (finishes sign-up or sign-in) |
| POST | `/api/auth/resend`, `/forgot`, `/reset`, `/logout` | new code · reset code by email · set new password · end session |
| GET/POST | `/api/employer/security[/…]` | password, authenticator app, recovery codes, sessions, trusted devices, notifications |
| GET | `/api/employer/applications.csv?job_id=&status=` | applicant export |
| POST | `/api/employer/applications/:id/notes` | `{ notes, rating }` private to the employer |
| PUT | `/api/employer/account` | edit name, title, phone, institution |
| POST | `/api/candidate-auth/request`, `/verify` | candidate sign-in links |
| GET/PUT | `/api/candidate` | Bearer ck_ token: profile + their applications |
| POST/GET | `/api/candidate/resume` | upload (extracts text) / download own résumé |
| GET | `/api/candidate/matches` | every open job ranked, with scores and reasons |
| POST | `/api/candidate/save` | bookmark `{ job_id, saved: true\|false }` |
| POST | `/api/candidate/apply` | one-click apply `{ job_id, cover_note? }` |
| GET | `/api/employer/talent?category=&state=&core_system=&license=` | anonymous talent pool (needs a live posting) |
| POST | `/api/employer/talent/:id/invite` | `{ job_id, note? }` → invite email to the candidate |
| POST | `/api/ai/posting` | `{ title, location?, category?, notes?… }` → `{ summary, description }` draft |
| POST | `/api/ai/apply-assist` | Bearer ck_: `{ job_id }` → `{ cover_note, tips[] }` from their own résumé |
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

62 real openings across every department, rebuilt November 2026 under a strict rule: **every sourced listing links to the institution's own careers site or ATS** — each URL was fetched and showed the job open at the time it was added. Third-party job-board links (Teal, Indeed, ZipRecruiter and the like) are refused by the admin form and auto-closed by the daily check; the daily check also closes any listing whose page 404s or says the job is gone. Listings expire after 30 days. Add fresh ones from `/#admin`.

## Worth doing next

- **Automated sourcing**: a scheduled function pulling bank tech roles from public ATS feeds (Workday, Greenhouse, Lever career pages of target banks).
- **Featured upgrade** (e.g. +$49 to pin a posting to the top of the landing page).
- **Employer team seats** (several recruiters per bank).
