export type TeamRole = 'ADMIN' | 'TEAM_LEAD' | 'MEMBER' | 'VIEWER';
export const CLAIMABLE_STATUSES = ['OPEN', 'IN_PROGRESS', 'BLOCKED'] as const;

export function canAccessTeam(memberships: { teamId: string; role: TeamRole }[], teamId: string): boolean {
  return memberships.some((m) => m.teamId === teamId) || memberships.some((m) => m.role === 'ADMIN');
}

export function canMutateTeam(memberships: { teamId: string; role: TeamRole }[], teamId: string): boolean {
  return memberships.some((m) => m.teamId === teamId && m.role !== 'VIEWER') || memberships.some((m) => m.role === 'ADMIN');
}

const transitions: Record<string, string[]> = {
  OPEN: ['IN_PROGRESS', 'BLOCKED', 'IN_REVIEW'],
  IN_PROGRESS: ['BLOCKED', 'IN_REVIEW', 'RESOLVED', 'OPEN'],
  BLOCKED: ['IN_PROGRESS', 'OPEN'],
  IN_REVIEW: ['IN_PROGRESS', 'RESOLVED'],
  RESOLVED: ['OPEN'],
};

export function isValidTransition(from: string, to: string): boolean {
  return transitions[from]?.includes(to) ?? false;
}

export function isClaimableStatus(status: string): boolean {
  return (CLAIMABLE_STATUSES as readonly string[]).includes(status);
}
