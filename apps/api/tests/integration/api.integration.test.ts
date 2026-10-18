import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config({ path: resolve(__dirname, '../../../../.env') });

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const enabled = Boolean(testDatabaseUrl);
const databaseIdentity = (value: string) => { const u = new URL(value); return `${u.hostname.toLowerCase()}:${u.port || '5432'}/${decodeURIComponent(u.pathname.slice(1)).toLowerCase()}`; };
let app: any;
let prisma: any;
let team: any;
let otherTeam: any;
let users: Record<string, any>;
let passwordHash: string;

describe.skipIf(!enabled)('OpsFlow PostgreSQL API integration', () => {
  beforeAll(async () => {
    const dbName = decodeURIComponent(new URL(testDatabaseUrl!).pathname.slice(1));
    if (dbName.toLowerCase() !== 'opsflow_test') throw new Error('Refusing integration tests: TEST_DATABASE_URL must name the dedicated opsflow_test database.');
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing integration tests while NODE_ENV=production.');
    if (process.env.DATABASE_URL && databaseIdentity(process.env.DATABASE_URL) === databaseIdentity(testDatabaseUrl!)) throw new Error('Refusing integration tests: TEST_DATABASE_URL resolves to DATABASE_URL.');
    process.env.DATABASE_URL = testDatabaseUrl!;
    process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'integration-test-only-secret-at-least-32-chars';
    process.env.NODE_ENV = 'test';
    ({ app, prisma } = await import('../../src/index'));
    passwordHash = await argon2.hash('integration-test-password', { type: argon2.argon2id, memoryCost: 8192, timeCost: 1, parallelism: 1 });
  });

  beforeEach(async () => {
    await prisma.$transaction([
      prisma.session.deleteMany(), prisma.approval.deleteMany(), prisma.idempotencyRecord.deleteMany(), prisma.comment.deleteMany(),
      prisma.activityLog.deleteMany(), prisma.workItem.deleteMany(), prisma.teamMembership.deleteMany(),
      prisma.team.deleteMany(), prisma.user.deleteMany(),
    ]);
    const [admin, lead, member, second, viewer, outsider] = await Promise.all([
      prisma.user.create({ data: { name: 'Admin User', email: 'admin@test.local', passwordHash } }),
      prisma.user.create({ data: { name: 'Team Lead', email: 'lead@test.local', passwordHash } }),
      prisma.user.create({ data: { name: 'Member One', email: 'member@test.local', passwordHash } }),
      prisma.user.create({ data: { name: 'Member Two', email: 'second@test.local', passwordHash } }),
      prisma.user.create({ data: { name: 'Read Only', email: 'viewer@test.local', passwordHash } }),
      prisma.user.create({ data: { name: 'Outsider', email: 'outsider@test.local', passwordHash } }),
    ]);
    users = { admin, lead, member, second, viewer, outsider };
    [team, otherTeam] = await Promise.all([
      prisma.team.create({ data: { name: `Engineering-${randomUUID()}` } }),
      prisma.team.create({ data: { name: `Finance-${randomUUID()}` } }),
    ]);
    await prisma.teamMembership.createMany({ data: [
      { teamId: team.id, userId: admin.id, role: 'ADMIN' },
      { teamId: team.id, userId: lead.id, role: 'TEAM_LEAD' },
      { teamId: team.id, userId: member.id, role: 'MEMBER' },
      { teamId: team.id, userId: second.id, role: 'MEMBER' },
      { teamId: team.id, userId: viewer.id, role: 'VIEWER' },
      { teamId: otherTeam.id, userId: outsider.id, role: 'MEMBER' },
      { teamId: otherTeam.id, userId: viewer.id, role: 'VIEWER' },
    ] });
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS fail_opsflow_activity ON "ActivityLog"');
    await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS fail_opsflow_activity()');
    await prisma.$transaction([
      prisma.session.deleteMany(), prisma.approval.deleteMany(), prisma.idempotencyRecord.deleteMany(), prisma.comment.deleteMany(),
      prisma.activityLog.deleteMany(), prisma.workItem.deleteMany(), prisma.teamMembership.deleteMany(),
      prisma.team.deleteMany(), prisma.user.deleteMany(),
    ]);
  });

  afterAll(async () => { if (prisma) await prisma.$disconnect(); });

  async function login(email: string) {
    const client: any = request.agent(app);
    let csrf = (await client.get('/api/auth/csrf')).body.data.csrfToken as string;
    const response = await client.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email, password: 'integration-test-password' });
    expect(response.status).toBe(200);
    csrf = response.body.data.csrfToken;
    for (const method of ['post', 'patch', 'delete', 'put']) {
      const original = client[method].bind(client);
      client[method] = (url: string) => original(url).set('X-CSRF-Token', csrf);
    }
    return client;
  }

  async function makeItem(options: { status?: string; teamId?: string; dueAt?: Date; assigneeId?: string | null; priority?: string } = {}) {
    return prisma.workItem.create({ data: {
      reference: `TEST-${randomUUID()}`, title: 'Test operational issue', description: 'A fixture for API tests',
      teamId: options.teamId ?? team.id, createdById: users.member.id, assigneeId: options.assigneeId,
      status: options.status ?? 'OPEN', dueAt: options.dueAt, priority: options.priority as any,
    } });
  }

  function createBarrier(parties: number) {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    return async () => { arrived += 1; if (arrived === parties) release(); await gate; };
  }

  it('rejects unauthenticated access, scopes outsider reads, and keeps viewers read-only', async () => {
    const item = await makeItem();
    expect((await request(app).get('/api/work-items')).status).toBe(401);
    const loginClient = request.agent(app);
    const csrf = (await loginClient.get('/api/auth/csrf')).body.data.csrfToken;
    expect((await loginClient.post('/api/auth/login').set('X-CSRF-Token', csrf).send({ email: 'member@test.local', password: 'wrong' })).status).toBe(401);
    const outsider = await login('outsider@test.local');
    expect((await outsider.get(`/api/work-items/${item.id}`)).status).toBe(404);
    expect((await outsider.get('/api/work-items').query({ teamId: team.id })).body.data).toHaveLength(0);
    const viewer = await login('viewer@test.local');
    expect((await viewer.patch(`/api/work-items/${item.id}`).send({ version: 1, priority: 'HIGH' })).status).toBe(403);
    expect((await viewer.post(`/api/work-items/${item.id}/claim`).send({})).status).toBe(403);
  });

  it('protects mutations with CSRF and allows admins to manage teams and memberships', async () => {
    const bare = request.agent(app);
    const token = (await bare.get('/api/auth/csrf')).body.data.csrfToken;
    const loginResponse = await bare.post('/api/auth/login').set('X-CSRF-Token', token).send({ email: 'admin@test.local', password: 'integration-test-password' });
    expect(loginResponse.status).toBe(200);
    const noToken = await bare.post('/api/teams').send({ name: 'No CSRF team' });
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('CSRF_INVALID');
    const admin = await login('admin@test.local');
    const lead = await login('lead@test.local');
    expect((await lead.post('/api/teams').send({ name: 'Lead forbidden team' })).status).toBe(403);
    const created = await admin.post('/api/teams').send({ name: 'New admin team', description: 'Managed by admin' });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    expect((await admin.post(`/api/teams/${id}/members`).send({ userId: 'missing-user', role: 'MEMBER' })).status).toBe(404);
    expect((await admin.post(`/api/teams/${id}/members`).send({ userId: users.member.id, role: 'INVALID' })).status).toBe(422);
    expect((await admin.post(`/api/teams/${id}/members`).send({ userId: users.member.id, role: 'MEMBER' })).status).toBe(201);
    const duplicate = await admin.post(`/api/teams/${id}/members`).send({ userId: users.member.id, role: 'MEMBER' });
    expect(duplicate.status).toBe(409);
    expect((await lead.get(`/api/teams/${id}/members`)).status).toBe(404);
    expect((await admin.patch(`/api/teams/${id}/members/${users.member.id}`).send({ role: 'TEAM_LEAD' })).body.data.role).toBe('TEAM_LEAD');
    expect((await admin.delete(`/api/teams/${id}/members/${users.member.id}`)).status).toBe(204);
    expect((await admin.delete(`/api/teams/${team.id}/members/${users.admin.id}`)).status).toBe(409);
  });

  it('rotates the session after login and invalidates it on logout', async () => {
    const member = request.agent(app);
    const csrfResponse = await member.get('/api/auth/csrf');
    const cookieValue = (headers: string | string[] | undefined) => (Array.isArray(headers) ? headers : headers ? [headers] : []).find(value => value.startsWith('opsflow.sid='))?.split(';')[0];
    const beforeLogin = cookieValue(csrfResponse.headers['set-cookie']);
    const loginResponse = await member.post('/api/auth/login').set('X-CSRF-Token', csrfResponse.body.data.csrfToken).send({ email: 'member@test.local', password: 'integration-test-password' });
    expect(loginResponse.status).toBe(200);
    const afterLogin = cookieValue(loginResponse.headers['set-cookie']);
    expect(afterLogin).toBeTruthy();
    expect(afterLogin).not.toBe(beforeLogin);
    expect((await member.get('/api/me')).status).toBe(200);
    expect(await prisma.session.count()).toBeGreaterThan(0);
    expect((await member.post('/api/auth/logout').set('X-CSRF-Token', loginResponse.body.data.csrfToken)).status).toBe(204);
    expect((await member.get('/api/me')).status).toBe(401);
    expect(await prisma.session.count()).toBe(0);
  });

  it('rejects assigning an item to a user outside its team', async () => {
    const lead = await login('lead@test.local');
    const response = await lead.post('/api/work-items').send({ title: 'Invalid assignment fixture', teamId: team.id, assigneeId: users.outsider.id });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVALID_ASSIGNEE');
  });

  it('allows team leads to assign members while preventing member reassignment', async () => {
    const item = await makeItem();
    const member = await login('member@test.local');
    const lead = await login('lead@test.local');
    expect((await member.patch(`/api/work-items/${item.id}`).send({ version: 1, assigneeId: users.second.id })).status).toBe(403);
    const assigned = await lead.patch(`/api/work-items/${item.id}`).send({ version: 1, assigneeId: users.second.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.assigneeId).toBe(users.second.id);
  });

  it('allows an admin to read a cross-team item while ordinary item lists remain scoped', async () => {
    const item = await makeItem({ teamId: otherTeam.id });
    const admin = await login('admin@test.local');
    expect((await admin.get(`/api/work-items/${item.id}`)).status).toBe(200);
    expect((await admin.get('/api/work-items').query({ teamId: otherTeam.id })).body.data).toHaveLength(1);
  });

  it('applies assignee filters on the server and scopes dashboard metrics and recent rows', async () => {
    const assignedToSecond = await makeItem({ assigneeId: users.second.id, priority: 'URGENT' });
    const assignedToOutsider = await makeItem({ teamId: otherTeam.id, assigneeId: users.outsider.id, priority: 'URGENT' });
    await makeItem({ teamId: otherTeam.id, status: 'RESOLVED' });
    const member = await login('member@test.local');
    const filtered = await member.get('/api/work-items').query({ assigneeId: users.second.id });
    expect(filtered.body.data.map((item: any) => item.id)).toEqual([assignedToSecond.id]);
    expect((await member.get('/api/work-items').query({ assigneeId: users.outsider.id })).body.data).toHaveLength(0);
    const dashboard = await member.get('/api/dashboard');
    expect(dashboard.body.data.metrics.open).toBe(1);
    expect(dashboard.body.data.metrics.urgent).toBe(1);
    expect(dashboard.body.data.metrics.closedThisWeek).toBe(0);
    expect(dashboard.body.data.teams.map((entry: any) => entry.id)).toEqual([team.id]);
    expect(dashboard.body.data.teams[0]._count.workItems).toBe(1);
    expect(dashboard.body.data.recent.map((item: any) => item.id)).toEqual([assignedToSecond.id]);
    const outsider = await login('outsider@test.local');
    const outsiderDashboard = await outsider.get('/api/dashboard');
    expect(outsiderDashboard.body.data.metrics.open).toBe(1);
    expect(outsiderDashboard.body.data.recent.map((item: any) => item.id)).toEqual([assignedToOutsider.id]);
    expect(outsiderDashboard.body.data.metrics.closedThisWeek).toBe(1);
    expect(outsiderDashboard.body.data.teams.map((entry: any) => entry.id)).toEqual([otherTeam.id]);
  });

  it('rejects invalid workflow transitions', async () => {
    const item = await makeItem({ status: 'OPEN' });
    const member = await login('member@test.local');
    const response = await member.post(`/api/work-items/${item.id}/transition`).send({ version: 1, status: 'RESOLVED' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INVALID_TRANSITION');
    expect((await prisma.workItem.findUnique({ where: { id: item.id } })).status).toBe('OPEN');
  });

  it('allows exactly one simultaneous claimant and writes one assignment audit event', async () => {
    const item = await makeItem();
    const [a, b] = await Promise.all([login('member@test.local'), login('second@test.local')]);
    const meet = createBarrier(2);
    const results = await Promise.all([
      (async () => { await meet(); return a.post(`/api/work-items/${item.id}/claim`).send({}); })(),
      (async () => { await meet(); return b.post(`/api/work-items/${item.id}/claim`).send({}); })(),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.filter(r => r.status === 200)).toHaveLength(1);
    const saved = await prisma.workItem.findUnique({ where: { id: item.id } });
    expect([users.member.id, users.second.id]).toContain(saved.assigneeId);
    expect(await prisma.activityLog.count({ where: { workItemId: item.id, action: 'ASSIGNED' } })).toBe(1);
    expect(saved.version).toBe(2);
  });

  it('makes a repeated claim by the winner idempotent and rejects resolved items', async () => {
    const item = await makeItem();
    const member = await login('member@test.local');
    expect((await member.post(`/api/work-items/${item.id}/claim`).send({})).status).toBe(200);
    const repeat = await member.post(`/api/work-items/${item.id}/claim`).send({});
    expect(repeat.status).toBe(200);
    expect(repeat.body.repeated).toBe(true);
    expect(await prisma.activityLog.count({ where: { workItemId: item.id, action: 'ASSIGNED' } })).toBe(1);
    const resolved = await makeItem({ status: 'RESOLVED' });
    const response = await member.post(`/api/work-items/${resolved.id}/claim`).send({});
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('NOT_CLAIMABLE');
  });

  it('rejects stale versions from a second reader without overwriting newer values and records the successful audit', async () => {
    const item = await makeItem();
    const [member, second] = await Promise.all([login('member@test.local'), login('second@test.local')]);
    const [firstRead, secondRead] = await Promise.all([member.get(`/api/work-items/${item.id}`), second.get(`/api/work-items/${item.id}`)]);
    expect(firstRead.body.data.version).toBe(1);
    expect(secondRead.body.data.version).toBe(1);
    expect((await member.patch(`/api/work-items/${item.id}`).send({ version: firstRead.body.data.version, priority: 'HIGH', dueAt: '2026-11-01T00:00:00.000Z' })).status).toBe(200);
    const stale = await second.patch(`/api/work-items/${item.id}`).send({ version: secondRead.body.data.version, title: 'Stale overwrite attempt' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STALE_VERSION');
    const saved = await prisma.workItem.findUnique({ where: { id: item.id } });
    expect(saved.priority).toBe('HIGH');
    expect(saved.title).toBe(item.title);
    expect(saved.version).toBe(2);
    expect(await prisma.activityLog.count({ where: { workItemId: item.id, action: 'UPDATED' } })).toBe(1);
    const event = await prisma.activityLog.findFirst({ where: { workItemId: item.id, action: 'UPDATED' } });
    expect(event.newValues.dueAt).toBe('2026-11-01T00:00:00.000Z');
    expect(event.oldValues.dueAt).toBeNull();
  });

  it('blocks cross-team reads and writes while allowing authorized team access and keeping viewers read-only', async () => {
    const item = await makeItem({ teamId: otherTeam.id });
    const member = await login('member@test.local');
    expect((await member.get(`/api/work-items/${item.id}`)).status).toBe(404);
    expect((await member.patch(`/api/work-items/${item.id}`).send({ version: 1, priority: 'URGENT' })).status).toBe(404);
    expect((await member.post(`/api/work-items/${item.id}/claim`).send({})).status).toBe(404);
    expect((await member.post(`/api/work-items/${item.id}/comments`).send({ version: 1, content: 'unauthorized' })).status).toBe(404);
    expect((await member.get('/api/work-items').query({ teamId: otherTeam.id })).body.data).toHaveLength(0);
    expect((await member.get('/api/work-items').query({ search: item.title })).body.data).toHaveLength(0);
    const dashboard = (await member.get('/api/dashboard')).body.data;
    expect(dashboard.teams.map((t: any) => t.id)).toEqual([team.id]);
    expect(dashboard.recent.some((row: any) => row.id === item.id)).toBe(false);

    const authorized = await login('outsider@test.local');
    expect((await authorized.get(`/api/work-items/${item.id}`)).status).toBe(200);
    const viewer = await login('viewer@test.local');
    expect((await viewer.get(`/api/work-items/${item.id}`)).status).toBe(200);
    expect((await viewer.patch(`/api/work-items/${item.id}`).send({ version: 1, priority: 'URGENT' })).status).toBe(403);
    expect((await viewer.post(`/api/work-items/${item.id}/claim`).send({})).status).toBe(403);
    expect((await viewer.post(`/api/work-items/${item.id}/comments`).send({ version: 1, content: 'viewer write' })).status).toBe(403);

    const saved = await prisma.workItem.findUnique({ where: { id: item.id } });
    expect(saved).toMatchObject({ status: 'OPEN', assigneeId: null, priority: 'MEDIUM', version: 1 });
    expect(await prisma.comment.count({ where: { workItemId: item.id } })).toBe(0);
    expect(await prisma.activityLog.count({ where: { workItemId: item.id } })).toBe(0);
  });

  it('rolls back a work item mutation when PostgreSQL rejects its audit insert', async () => {
    const item = await makeItem();
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fail_opsflow_activity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced audit failure'; END; $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER fail_opsflow_activity BEFORE INSERT ON "ActivityLog" FOR EACH ROW EXECUTE FUNCTION fail_opsflow_activity()');
    const member = await login('member@test.local');
    expect((await member.patch(`/api/work-items/${item.id}`).send({ version: 1, priority: 'URGENT' })).status).toBe(500);
    const saved = await prisma.workItem.findUnique({ where: { id: item.id } });
    expect(saved.priority).toBe('MEDIUM');
    expect(saved.version).toBe(1);
    expect(await prisma.activityLog.count({ where: { workItemId: item.id } })).toBe(0);
  });

  it('deduplicates simultaneous creates and conflicts when a key is reused for different input', async () => {
    const member = await login('member@test.local');
    const key = randomUUID();
    const body = { title: 'Idempotent creation', description: 'same request', teamId: team.id };
    const [first, second] = await Promise.all([
      member.post('/api/work-items').set('Idempotency-Key', key).send(body),
      member.post('/api/work-items').set('Idempotency-Key', key).send(body),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect(first.body.data.id).toBe(second.body.data.id);
    expect(await prisma.workItem.count({ where: { title: body.title } })).toBe(1);
    expect(await prisma.activityLog.count({ where: { workItemId: first.body.data.id, action: 'CREATED' } })).toBe(1);
    const mismatch = await member.post('/api/work-items').set('Idempotency-Key', key).send({ ...body, title: 'Different payload' });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('uses bounded, deterministic database pagination and rejects oversized pages', async () => {
    const member = await login('member@test.local');
    await Promise.all(Array.from({ length: 5 }, (_, i) => makeItem().then(item => prisma.workItem.update({ where: { id: item.id }, data: { title: `Pagination fixture ${i}` } }))));
    const page1 = await member.get('/api/work-items').query({ page: 1, pageSize: 2, sort: 'createdAt', direction: 'asc' });
    const page2 = await member.get('/api/work-items').query({ page: 2, pageSize: 2, sort: 'createdAt', direction: 'asc' });
    expect(page1.body.meta.total).toBe(5);
    expect(page1.body.data).toHaveLength(2);
    expect(page2.body.data).toHaveLength(2);
    expect(page1.body.data.map((x: any) => x.id).some((id: string) => page2.body.data.some((x: any) => x.id === id))).toBe(false);
    expect((await member.get('/api/work-items').query({ pageSize: 101 })).status).toBe(422);
    expect((await member.get('/api/work-items').query({ page: 10001 })).status).toBe(422);
  });

  it('paginates comments with a stable cursor and bounded batches', async () => {
    const item = await makeItem();
    await prisma.comment.createMany({ data: Array.from({ length: 55 }, (_, i) => ({ workItemId: item.id, authorId: users.member.id, content: `Comment ${i}` })) });
    const member = await login('member@test.local');
    const first = await member.get(`/api/work-items/${item.id}/comments`);
    expect(first.body.data).toHaveLength(50);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await member.get(`/api/work-items/${item.id}/comments`).query({ cursor: first.body.nextCursor });
    expect(second.body.data).toHaveLength(5);
    expect(first.body.data.some((x: any) => second.body.data.some((y: any) => x.id === y.id))).toBe(false);
  });

  it('enforces approval membership, authorization, and independent decisions', async () => {
    const item = await makeItem();
    const member = await login('member@test.local');
    expect((await member.post(`/api/work-items/${item.id}/approvals`).send({ approverId: users.member.id })).status).toBe(422);
    expect((await member.post(`/api/work-items/${item.id}/approvals`).send({ approverId: users.viewer.id })).status).toBe(422);
    const created = await member.post(`/api/work-items/${item.id}/approvals`).send({ approverId: users.second.id });
    expect(created.status).toBe(201);
    const outsider = await login('outsider@test.local');
    expect((await outsider.post(`/api/approvals/${created.body.data.id}/decision`).send({ decision: 'APPROVED' })).status).toBe(404);
    const approver = await login('second@test.local');
    expect((await approver.post(`/api/approvals/${created.body.data.id}/decision`).send({ decision: 'APPROVED', comment: 'Reviewed' })).status).toBe(200);
    expect(await prisma.activityLog.count({ where: { workItemId: item.id, action: 'APPROVAL_DECIDED' } })).toBe(1);
  });
});
