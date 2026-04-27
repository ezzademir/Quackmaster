/**
 * Approval Workflow State Machine
 * Formalizes approval logic with clear state transitions
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalWorkflowState {
  id: string;
  status: ApprovalStatus;
  created_at: string;
  reviewed_at?: string;
  reviewed_by?: string;
  rejection_reason?: string;
}

export interface ApprovalTransition {
  from: ApprovalStatus;
  to: ApprovalStatus;
  allowedRoles: ('admin' | 'staff')[];
  requiresReason?: boolean;
}

export interface ApprovalAction {
  action: 'approve' | 'reject';
  reviewerId: string;
  rejectionReason?: string;
}

/**
 * Valid approval state transitions
 */
const APPROVAL_TRANSITIONS: Record<ApprovalStatus, ApprovalTransition[]> = {
  pending: [
    { from: 'pending', to: 'approved', allowedRoles: ['admin'] },
    { from: 'pending', to: 'rejected', allowedRoles: ['admin'], requiresReason: true },
  ],
  approved: [],
  rejected: [{ from: 'rejected', to: 'pending', allowedRoles: ['admin'] }],
};

/**
 * Check if a transition is allowed
 */
export function isTransitionAllowed(
  currentStatus: ApprovalStatus,
  nextStatus: ApprovalStatus,
  userRole: 'admin' | 'staff'
): { allowed: boolean; reason?: string } {
  const transitions = APPROVAL_TRANSITIONS[currentStatus];

  if (!transitions) {
    return { allowed: false, reason: `No transitions defined for status "${currentStatus}"` };
  }

  const validTransition = transitions.find((t) => t.to === nextStatus);

  if (!validTransition) {
    return { allowed: false, reason: `Cannot transition from "${currentStatus}" to "${nextStatus}"` };
  }

  if (!validTransition.allowedRoles.includes(userRole)) {
    return {
      allowed: false,
      reason: `User role "${userRole}" is not authorized for this transition`,
    };
  }

  return { allowed: true };
}

/**
 * Validate an approval action
 */
export function validateApprovalAction(
  currentStatus: ApprovalStatus,
  action: ApprovalAction,
  userRole: 'admin' | 'staff'
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check if user is authorized
  if (userRole !== 'admin') {
    errors.push('Only admins can approve or reject users');
  }

  // Check state transition
  const targetStatus = action.action === 'approve' ? 'approved' : 'rejected';
  const transition = isTransitionAllowed(currentStatus, targetStatus, userRole);
  if (!transition.allowed) {
    errors.push(transition.reason || 'Invalid transition');
  }

  // Check rejection reason
  if (action.action === 'reject' && !action.rejectionReason?.trim()) {
    errors.push('Rejection reason is required');
  }

  // Reviewer ID must be provided
  if (!action.reviewerId?.trim()) {
    errors.push('Reviewer ID is required');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Apply an approval action and return new state
 */
export function applyApprovalAction(
  currentState: ApprovalWorkflowState,
  action: ApprovalAction
): ApprovalWorkflowState {
  const targetStatus = action.action === 'approve' ? 'approved' : 'rejected';

  return {
    ...currentState,
    status: targetStatus,
    reviewed_at: new Date().toISOString(),
    reviewed_by: action.reviewerId,
    ...(action.action === 'reject' && { rejection_reason: action.rejectionReason }),
  };
}

/**
 * Get workflow history for audit trail
 */
export interface ApprovalHistory {
  id: string;
  old_status: ApprovalStatus;
  new_status: ApprovalStatus;
  reviewed_by: string;
  reviewed_at: string;
  reason?: string;
}

/**
 * Check if an approval is final (no further transitions possible)
 */
export function isApprovalFinal(status: ApprovalStatus): boolean {
  const transitions = APPROVAL_TRANSITIONS[status];
  return transitions && transitions.length === 0;
}

/**
 * Get available next states from current status
 */
export function getAvailableNextStates(currentStatus: ApprovalStatus, userRole: 'admin' | 'staff'): ApprovalStatus[] {
  const transitions = APPROVAL_TRANSITIONS[currentStatus];

  if (!transitions) {
    return [];
  }

  return transitions
    .filter((t) => t.allowedRoles.includes(userRole))
    .map((t) => t.to);
}

/**
 * Format approval timeline for display
 */
export function formatApprovalTimeline(states: ApprovalWorkflowState[]): Array<{
  status: ApprovalStatus;
  timestamp: string;
  reviewedBy?: string;
  reason?: string;
}> {
  return states.map((s) => ({
    status: s.status,
    timestamp: s.reviewed_at || s.created_at,
    reviewedBy: s.reviewed_by,
    reason: s.rejection_reason,
  }));
}
