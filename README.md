# OpsFlow

OpsFlow is a small, team-scoped operations work platform for the Newtonite engineering assessment. It includes a React/Vite dashboard and a Node/Express API backed by PostgreSQL through Prisma.

## Architecture

`apps/web` contains the responsive React client, with React Router, TanStack Query, React Hook Form, Zod, Tailwind CSS and Lucide icons. `apps/api` contains the Express API, validation, session authentication, authorization, and database-backed business logic. `prisma/schema.prisma` defines the relational schema. The API runs on port 4000 and the web development server on port 5173.

## Prerequisites and local setup

- Node.js 20.19+ or 22.12+ and npm.
- Docker Desktop (or a local PostgreSQL 16+ instance). Docker and `psql` were not installed in the authoring environment.

From the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
docker compose up -d db
npm install
npm run db:generate --workspace apps/api
npm run db:migrate --workspace apps/api
npm run db:seed --workspace apps/api
npm run dev
```

Open <http://localhost:5173>. Prisma migration prompts for a development migration name on first run. To inspect the API directly visit <http://localhost:4000/api/health>. `DATABASE_URL` and a 32-character `SESSION_SECRET` are required at API startup. Change the local-only secret before deployment. Sessions are stored in PostgreSQL (`Session` table), expire after 8 hours, rotate after successful login, and are deleted at logout. Cookies are HTTP-only, `SameSite=Lax`, and secure in production. Set `TRUST_PROXY=true` only behind one trusted reverse proxy. For a genuinely cross-site HTTPS deployment, set `COOKIE_SAME_SITE=none`; the cookie remains secure in production. The API uses a session-bound synchronizer CSRF token returned by `GET /api/auth/csrf`; the web client sends it on every unsafe method. CORS permits the configured `WEB_ORIGIN` with credentials and an explicit header allowlist.

## Local demo accounts

All seeded users have the development-only password `OpsFlow-Demo-2026!`:

| Role | Email |
|---|---|
| Admin | `admin@opsflow.local` |
| Team lead | `lead@opsflow.local` |
| Member | `member@opsflow.local` |
| Viewer | `viewer@opsflow.local` |
| Engineering-only member | `engineering-only@opsflow.local` |
| Support-only member | `support-only@opsflow.local` |

Seed data is deterministic and repeatable; the script upserts users, teams, and memberships, and adds the demo work items only when the work-item table is empty. The two scoped demo accounts are members of only their named team and are provided for access-boundary demonstrations. All demo credentials are development-only.

## API overview

- Auth: `GET /api/auth/csrf`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/me`.
- Teams and directory: `GET /api/teams`, `GET /api/teams/:id`, `GET /api/teams/:id/members`, `POST/PATCH /api/teams`, `POST/PATCH/DELETE /api/teams/:id/members/:userId`, `GET /api/users?teamId=...` (or scoped directory across visible teams).
- Work: `GET/POST /api/work-items`, `GET/PATCH /api/work-items/:id`, `POST /api/work-items/:id/claim`, `POST /api/work-items/:id/transition`, `GET /api/work-items/:id/activity`, `GET/POST /api/work-items/:id/comments`.
- Approvals: `POST /api/work-items/:id/approvals`, `GET /api/approvals/pending`, `POST /api/approvals/:approvalId/decision`.
- Dashboard: `GET /api/dashboard` (authorized metrics and recent items).

List endpoint query parameters support bounded page/pageSize (maximum 100; page number capped at 10,000), search, status, priority, team, assignee, overdue, and sorting. Count and page rows share a repeatable-read snapshot; sorting includes a stable id tie-breaker. Work item updates, transitions, and comments require the last-read `version`. On conflicts the server returns `409 STALE_VERSION`; refresh the detail page and reconcile the change. Claims are eligible in `OPEN`, `IN_PROGRESS`, and `BLOCKED`; the conditional assignment and audit write share a transaction. A repeated claim by the current assignee returns the item successfully; a competing claim gets `409 ALREADY_CLAIMED`. Creation supports persistent `Idempotency-Key` values scoped to user and operation. Reusing a key with another payload returns `409 IDEMPOTENCY_KEY_REUSED`.

## Authorization and audit

Protected work queries, directory results, dashboard counts, and dashboard recent items are scoped to the user's team memberships; an admin role grants cross-team read and mutation access. ADMIN alone can create/update teams and add, change, or remove memberships. TEAM_LEAD can manage team work and assign/reassign eligible members; MEMBER can use permitted work mutations and claim eligible unassigned items but cannot reassign; VIEWER is read-only. Routes return 404 for out-of-scope team/work resources. Assignees and approval reviewers must be eligible, non-viewer members of the item team. Approval requesters cannot approve their own requests. Audited updates and their activity rows share a Prisma transaction; the work item version is incremented conditionally. SQL constraints enforce unique email/team membership, references, and idempotency keys.

## Tests and checks

Run `npm test --workspace apps/api` for API policy unit tests, `npm run build` for TypeScript and production frontend builds, and `npm run db:generate --workspace apps/api` after schema changes. Docker Compose creates both `opsflow` and (on first volume initialization) a dedicated `opsflow_test` database. Set `TEST_DATABASE_URL` explicitly in `.env`, then use the guarded migration command and run the suite (PowerShell):

```powershell
npm run db:test:deploy --workspace apps/api
npm run test:integration --workspace apps/api
```

For the synchronized claim, stale-version, and cross-team scenarios only, run `npm run test:critical`. See [DEMO_SCRIPT.md](DEMO_SCRIPT.md) for the live walkthrough and database verification queries.

On a pre-existing Docker volume, create the test database once with `docker compose exec db psql -U opsflow -d postgres -c "CREATE DATABASE opsflow_test OWNER opsflow"`. The guarded migration and integration harness both require the dedicated database name `opsflow_test`, refuse a database identity matching `DATABASE_URL`, and refuse `NODE_ENV=production`; the harness clears only fixture tables in that verified test database. It exercises simultaneous claim winners (asserting exactly one success), same-user retries, stale versions, audit rollback via a PostgreSQL trigger, idempotent creation, authorization, CSRF, session invalidation, administration, approvals, and pagination. If `TEST_DATABASE_URL` is unset, Vitest skips this suite; a skip is not a pass.

## Known limitations

- No UI for team/membership administration is included; the admin-only API endpoints are implemented.
- Comments are append-only. Comments and audit history are bounded to 50 entries per request and support cursor pagination. Activity logs restrict deletion of a referenced work item to preserve the audit trail.
- No separate cursor-based pagination or full-text database index yet; item lists use indexed offset pagination and case-insensitive substring search.
- The test harness and PostgreSQL session store require Prisma migrations to be applied to their respective databases.
- No async queue, notifications, or transaction outbox are included.
- No frontend component test script is configured. PostgreSQL-backed integration behavior is covered in source, but remains unverified until the suite is actually run against PostgreSQL.

## Verification status

**Implemented:** Prisma-backed expiring sessions and CSRF checks; role-protected team/membership API; server-side assignee filtering; scoped dashboard/list data; transactional audited writes; optimistic concurrency; atomic claim; idempotent create; bounded database pagination. Integration source now synchronizes concurrent claim starts and checks cross-team read/write boundaries and two-reader stale edits.

**Verified in this workspace:** API policy tests, API and frontend TypeScript/production build, and Prisma schema validation. The integration suite contains PostgreSQL tests for the listed database guarantees.

**Unverified here:** PostgreSQL transaction/concurrency/rollback execution. This workspace has no Docker or `psql` executable and localhost:5432 does not accept connections; Vitest skips the integration suite when `TEST_DATABASE_URL` is unset. Follow the dedicated database commands above to run it locally. A test added to source is not a test execution result.
