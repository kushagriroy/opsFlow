import { describe, expect, it } from 'vitest';
import { canAccessTeam, canMutateTeam, isClaimableStatus, isValidTransition } from './policy';

describe('team authorization policy', () => {
  it('limits ordinary roles to their own team and keeps viewers read-only', () => {
    const memberships = [{ teamId: 'eng', role: 'VIEWER' as const }];
    expect(canAccessTeam(memberships, 'eng')).toBe(true);
    expect(canMutateTeam(memberships, 'eng')).toBe(false);
    expect(canAccessTeam(memberships, 'finance')).toBe(false);
  });

  it('allows admins to operate across team boundaries', () => {
    const memberships = [{ teamId: 'eng', role: 'ADMIN' as const }];
    expect(canAccessTeam(memberships, 'finance')).toBe(true);
    expect(canMutateTeam(memberships, 'finance')).toBe(true);
  });
});

describe('work item workflow', () => {
  it('allows documented moves and rejects invalid transitions', () => {
    expect(isValidTransition('OPEN', 'IN_PROGRESS')).toBe(true);
    expect(isValidTransition('IN_REVIEW', 'RESOLVED')).toBe(true);
    expect(isValidTransition('OPEN', 'RESOLVED')).toBe(false);
    expect(isValidTransition('RESOLVED', 'BLOCKED')).toBe(false);
  });

  it('allows claims only in active, actionable statuses', () => {
    expect(isClaimableStatus('OPEN')).toBe(true);
    expect(isClaimableStatus('IN_PROGRESS')).toBe(true);
    expect(isClaimableStatus('BLOCKED')).toBe(true);
    expect(isClaimableStatus('IN_REVIEW')).toBe(false);
    expect(isClaimableStatus('RESOLVED')).toBe(false);
  });
});
