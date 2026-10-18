# Engineering decisions

## 1. PostgreSQL and a relational model

**Chosen:** PostgreSQL with Prisma relations, foreign keys, unique constraints, and focused composite indexes. Teams, users, memberships, work, approvals, comments, and audit events have clear ownership and referential rules.

**Alternatives:** A document database or embedding history in work items. **Trade-offs:** relational joins and migrations add operational setup, but constraints and transactions are important for authorization and audit correctness. Audit rows and identity relations use restrictive deletes; memberships cascade with their parent and comments/history cascade with a deleted item. In production, item/audit retention should be governed by a formal retention policy.

## 2. Optimistic concurrency and HTTP 409

**Chosen:** the client submits a read `version`; mutations use `updateMany` with both item identity and version predicates and increment the version in the same transaction that inserts activity. **Alternatives:** lock rows on every edit or last-write-wins. Locks add contention and last-write-wins loses user work. A failed predicate becomes `409 STALE_VERSION`; clients refresh and reconcile rather than blindly retrying.

The PostgreSQL integration source has two independent clients read the same version, then verifies the second writer receives `STALE_VERSION`, cannot overwrite the committed values, and creates no second update event. The detail UI presents a conflict banner and refresh action. Runtime behavior remains unverified until these tests run against PostgreSQL.

## 3. Atomic claiming and transaction boundaries

**Chosen:** claim by conditional update where the current assignee is null, increment version and insert activity in a transaction. A repeated claim by the same assignee is idempotent; a competing claim returns `409 ALREADY_CLAIMED`. **Alternatives:** read then update (race-prone) or a separate assignment transaction (audit could diverge). The conditional database write decides the winner.

The integration test releases both claimant clients through a shared barrier before sending requests and asserts exactly one success, one conflict, the persisted winner/version, and a single assignment event. This assertion is present in code; PostgreSQL execution is still outstanding in environments without the database service.

## 4. Backend authorization and team membership

**Chosen:** centralized role predicates and membership-scoped Prisma queries, with a deliberate 404 for out-of-scope items. A user with any ADMIN membership has global access; team leads manage team work and assignments; members can perform permitted work actions and claim eligible items but cannot reassign; viewers read only. Only ADMIN can create/update teams or change memberships. Assignees and approvers must be eligible team members. Directory, item lists, dashboard metrics, and recent dashboard rows are scoped server-side. **Alternatives:** frontend-only controls or globally fetching then filtering. Those approaches expose data or trust the client; membership joins add query complexity but make the API authoritative.

## 5. Audit, idempotency, and asynchronous work

**Chosen:** insert activity in the same database transaction as each audited mutation; the foreign key restricts deletion of a work item with audit history. Work item creation optionally stores a unique user/operation/key record with the operation and request hash; a payload mismatch is a conflict. **Alternatives:** best-effort logs and volatile idempotency caches can lose events on failure/restart. Transactional consistency costs a small amount of write latency. Background notifications are deferred; no queue is needed for the current synchronous scope, and no external side effect is allowed to block a successful mutation.

## Authentication and CSRF

**Chosen:** express-session identifiers and serialized session data live in the Prisma `Session` table with an indexed expiry, an eight-hour lifetime, expiry checks on reads, and opportunistic pruning. Login regenerates the session id and CSRF token; logout deletes the server-side record. Cookies are HTTP-only, SameSite=Lax, and Secure in production. A synchronizer token is issued from `GET /api/auth/csrf` and required in `X-CSRF-Token` for unsafe API methods, including login and logout. CORS uses the configured exact web origin and credentials. **Alternatives:** process memory does not survive restarts or work across API instances; a client-stored bearer token would change the existing authentication contract. The PostgreSQL store reuses the production database and requires migrations. For cross-site deployments use HTTPS and `COOKIE_SAME_SITE=none`; configure trusted proxy handling only when a reverse proxy is in use.

## Pagination, search, and deployment notes

Work lists use bounded database offset pagination (maximum 100 rows, page cap 10,000), indexed by team/status, priority, assignee, due date, and update time. Count and result rows share a repeatable-read snapshot and ordered results include a stable id tie-breaker. Activity uses a stable timestamp/id cursor and bounded batches; comments are bounded to batches of 50. Search currently uses case-insensitive substring matching, which is adequate for a demo but should become PostgreSQL full-text or trigram search for a larger corpus. Integration tests assert concurrency and rollback guarantees through PostgreSQL. They are implemented but remain unverified unless run against a separately migrated `opsflow_test` database; skipped tests are not evidence of database behavior.

The seeded `engineering-only@opsflow.local` and `support-only@opsflow.local` users support a repeatable live authorization demonstration. See `DEMO_SCRIPT.md` for the runbook, expected HTTP outcomes, and database inspection queries. The cross-team integration scenario checks detail, update, claim, comment, filtered list/search, dashboard, authorized member reads, and viewer write denial, including unchanged persisted state.
