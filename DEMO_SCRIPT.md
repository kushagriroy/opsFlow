# OpsFlow critical scenario demo

This walkthrough demonstrates database-backed concurrent claims, stale-version protection, and team authorization. Run it against a disposable local development database; the integration test database is separate and must not contain demo data.

## Start the application

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

Open `http://localhost:5173`. Seeded accounts use the development-only password `OpsFlow-Demo-2026!`.

| Account | Role / scope |
|---|---|
| `admin@opsflow.local` | ADMIN across all seeded teams |
| `lead@opsflow.local` | TEAM_LEAD across all seeded teams |
| `member@opsflow.local` | MEMBER across all seeded teams |
| `viewer@opsflow.local` | VIEWER across all seeded teams |
| `engineering-only@opsflow.local` | MEMBER in Engineering only |
| `support-only@opsflow.local` | MEMBER in Support only |

## Scenario 1: simultaneous claim

1. Open two independent browser profiles (or separate browser sessions) and sign in as `member@opsflow.local` and `lead@opsflow.local`.
2. Open the same unassigned claimable item, such as `OPS-4104` (“Review Q4 vendor invoices”), in both sessions. Make sure both pages show it as unassigned before proceeding.
3. Click **Claim item** in both sessions as close together as possible. In DevTools → Network, inspect the two `POST /api/work-items/:id/claim` responses.
4. Exactly one request should return 200 and assign the item; the competing request should return 409 `ALREADY_CLAIMED`. The winning account should remain the assignee. Repeating the winner’s claim returns 200 with `repeated: true` and does not add another assignment event.

The integration test synchronizes both request starts with a barrier and asserts one 200, one 409, one final assignee, version 2, and exactly one `ASSIGNED` audit event.

## Scenario 2: stale edit

1. Sign in as `member@opsflow.local` and `lead@opsflow.local` in two sessions. Open the same work item in both; note that both show the same version.
2. In the first session, change the priority and save it.
3. In the second session, make another edit using the page that still has the earlier version.
4. The API returns 409 `STALE_VERSION`. The detail page shows a conflict banner and **Refresh latest** action. Refresh to review the committed values before making a new edit. The first change remains stored; the stale title/value is not applied, and only the successful edit has an `UPDATED` event.

## Scenario 3: team boundary and viewer permissions

1. Sign in as `support-only@opsflow.local`, create or open a Support item, and copy its item URL.
2. Sign in as `engineering-only@opsflow.local` and open that URL. The API returns 404. Try a mutation through the item UI or DevTools (`PATCH` item, claim, or comment); out-of-scope item routes also return 404. The item, comments, and activity remain unchanged. Search, list filters, and dashboard rows/metrics show only Engineering data.
3. Sign back in as the authorized Support member and confirm the same item is visible.
4. Sign in as `viewer@opsflow.local`, open the Support item, and attempt a priority update, claim, or comment. Reads work, while each write is denied with 403.

The demo accounts have the same seeded password. API mutations from the browser use the session cookie and synchronizer token (`X-CSRF-Token`) automatically.

## Verify database state

Use the local development database from another PowerShell window. Replace the reference if you demoed a newly created item:

```powershell
docker compose exec db psql -U opsflow -d opsflow -c 'SELECT id, reference, status, "assigneeId", version FROM "WorkItem" WHERE reference = ''OPS-4104'';'
```

For the assignment history, copy the returned item id and run:

```sql
SELECT action, "actorId", "oldValues", "newValues", "createdAt"
FROM "ActivityLog" WHERE "workItemId" = '<item-id>' ORDER BY "createdAt", id;
SELECT id, "authorId", content, "createdAt" FROM "Comment" WHERE "workItemId" = '<item-id>' ORDER BY "createdAt", id;
```

For membership verification:

```sql
SELECT u.email, t.name, tm.role
FROM "TeamMembership" tm JOIN "User" u ON u.id = tm."userId" JOIN "Team" t ON t.id = tm."teamId"
WHERE u.email IN ('engineering-only@opsflow.local', 'support-only@opsflow.local')
ORDER BY u.email, t.name;
```

## Run critical PostgreSQL tests

Configure `TEST_DATABASE_URL` to a dedicated database whose name is exactly `opsflow_test`, distinct from `DATABASE_URL`. The harness checks these conditions before clearing fixtures. Then run:

```powershell
npm run db:test:deploy --workspace apps/api
npm run test:critical
npm run test:integration
```

The critical command selects the synchronized claim, stale-version, and cross-team scenarios. The complete suite also includes rollback via a PostgreSQL trigger, creation idempotency, pagination, session/CSRF, team administration, and approval cases. A Vitest skip means PostgreSQL behavior has not been verified.
