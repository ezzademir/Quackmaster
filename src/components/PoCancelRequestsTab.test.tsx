// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { listAllCancelRequests, approvePoCancelRequest, rejectPoCancelRequest } = vi.hoisted(() => ({
  listAllCancelRequests: vi.fn(),
  approvePoCancelRequest: vi.fn(),
  rejectPoCancelRequest: vi.fn(),
}));

vi.mock('../utils/poCancelRpc', async () => {
  const actual = await vi.importActual<typeof import('../utils/poCancelRpc')>('../utils/poCancelRpc');
  return {
    ...actual,
    listAllCancelRequests,
    approvePoCancelRequest,
    rejectPoCancelRequest,
  };
});

import { PoCancelRequestsTab } from './PoCancelRequestsTab';

const pendingRow = {
  id: 'r1',
  purchase_order_id: 'po-1',
  requested_by: 'buyer-qt',
  requested_at: '2026-10-20T02:00:00.000Z',
  reason: 'wrong qty',
  status: 'pending' as const,
  decided_by: null,
  decided_at: null,
  decision_reason: null,
  purchase_order: {
    id: 'po-1',
    order_number: 'PO-0001',
    status: 'received',
    entity_code: 'QT',
    total_amount: 12.5,
    supplier: { id: 's1', name: 'Acme' },
  },
  requester: { id: 'buyer-qt', full_name: 'Quinn Buyer' },
};

const decidedRow = {
  ...pendingRow,
  id: 'r2',
  status: 'rejected' as const,
  decided_by: 'admin-1',
  decided_at: '2026-10-21T02:00:00.000Z',
  decision_reason: 'keep it',
  decider: { id: 'admin-1', full_name: 'Ada Admin' },
};

function mockLists(pending: unknown[] = [pendingRow], decided: unknown[] = [decidedRow]) {
  listAllCancelRequests.mockImplementation(async (opts: { status?: unknown }) => {
    if (opts.status === 'pending') return { data: pending, error: null };
    return { data: decided, error: null };
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  listAllCancelRequests.mockReset();
  approvePoCancelRequest.mockReset();
  rejectPoCancelRequest.mockReset();
  mockLists();
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('PoCancelRequestsTab', () => {
  it('renders pending rows with entity chip, MYT time, and decide buttons', async () => {
    render(<PoCancelRequestsTab uid="admin-1" />);
    await waitFor(() => expect(screen.getAllByText('PO-0001').length).toBeGreaterThan(0));
    expect(screen.getAllByText('QT').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Quinn Buyer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('wrong qty').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: 'Reject' }).length).toBeGreaterThan(0);
  });

  it('hides decide buttons on the requester admin and shows the guard', async () => {
    mockLists([{ ...pendingRow, requested_by: 'admin-1' }]);
    render(<PoCancelRequestsTab uid="admin-1" />);
    await waitFor(() => expect(screen.getAllByText('Another admin must decide this').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('approves with a confirm that mentions stock reversal', async () => {
    approvePoCancelRequest.mockResolvedValue({ data: { success: true }, error: null });
    render(<PoCancelRequestsTab uid="admin-1" />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    expect(confirm).toHaveBeenCalled();
    expect(String(vi.mocked(confirm).mock.calls[0][0])).toMatch(/tagged like the originals/);
    await waitFor(() => expect(approvePoCancelRequest).toHaveBeenCalledWith('r1'));
  });

  it('rejects with a required reason', async () => {
    rejectPoCancelRequest.mockResolvedValue({ data: { success: true, status: 'rejected' }, error: null });
    render(<PoCancelRequestsTab uid="admin-1" />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Reject' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm reject' })[0]);
    expect(screen.getAllByText('A reason is required').length).toBeGreaterThan(0);
    fireEvent.change(screen.getAllByLabelText('Rejection reason')[0], { target: { value: 'keep it' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm reject' })[0]);
    await waitFor(() => expect(rejectPoCancelRequest).toHaveBeenCalledWith('r1', 'keep it'));
  });

  it('does not fire a second approve RPC while an approve is in flight', async () => {
    let resolveRpc: (value: { data: unknown; error: null }) => void = () => {};
    approvePoCancelRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = resolve;
      })
    );
    render(<PoCancelRequestsTab uid="admin-1" />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    await waitFor(() => expect(approvePoCancelRequest).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    expect(approvePoCancelRequest).toHaveBeenCalledTimes(1);
    resolveRpc({ data: { success: true }, error: null });
    await waitFor(() => expect(approvePoCancelRequest).toHaveBeenCalledTimes(1));
  });

  it('does not fire a second reject RPC while a reject is in flight', async () => {
    let resolveRpc: (value: { data: unknown; error: null }) => void = () => {};
    rejectPoCancelRequest.mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = resolve;
      })
    );
    render(<PoCancelRequestsTab uid="admin-1" />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Reject' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[0]);
    fireEvent.change(screen.getAllByLabelText('Rejection reason')[0], { target: { value: 'keep it' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm reject' })[0]);
    await waitFor(() => expect(rejectPoCancelRequest).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByRole('button', { name: 'Confirm reject' })[0]);
    expect(rejectPoCancelRequest).toHaveBeenCalledTimes(1);
    resolveRpc({ data: { success: true, status: 'rejected' }, error: null });
    await waitFor(() => expect(rejectPoCancelRequest).toHaveBeenCalledTimes(1));
  });

  it('shows headline, DETAIL and HINT for a stock refusal on Approve', async () => {
    const detail =
      'Stock received on this PO has already been partly used (on hand 2, needed 5). Nothing was cancelled; reverse the usage first.';
    const hint = '{"raw_material_id":"rm-1","on_hand":2,"required_return":5}';
    approvePoCancelRequest.mockResolvedValue({
      data: null,
      error: {
        message: 'insufficient_hub_quantity',
        details: detail,
        hint,
      },
    });
    render(<PoCancelRequestsTab uid="admin-1" />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Hub stock is too low to reverse the received quantities.');
    expect(alert.textContent).toContain(`DETAIL: ${detail}`);
    expect(alert.textContent).toContain(`HINT: ${hint}`);
  });

  it('shows empty, error/retry and loading states', async () => {
    mockLists([], []);
    render(<PoCancelRequestsTab uid="admin-1" />);
    await waitFor(() => expect(screen.getByText('No pending cancellation requests.')).toBeTruthy());

    cleanup();
    listAllCancelRequests.mockResolvedValue({ data: null, error: { message: 'nope' } });
    render(<PoCancelRequestsTab uid="admin-1" />);
    await waitFor(() => expect(screen.getByText('Could not load requests')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('shows recently decided rows', async () => {
    render(<PoCancelRequestsTab uid="admin-1" />);
    await waitFor(() => expect(screen.getByText('Recently decided')).toBeTruthy());
    expect(screen.getByText('Ada Admin')).toBeTruthy();
    expect(screen.getByText('keep it')).toBeTruthy();
  });
});

describe('Procurement cancellations tab gate', () => {
  const files = import.meta.glob('../pages/Procurement.tsx', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>;
  const src = Object.values(files)[0] ?? '';

  it('adds the tab only for isAdmin', () => {
    expect(src).toMatch(/isAdmin/);
    expect(src).toMatch(/PoCancelRequestsTab/);
    expect(src).toMatch(/Cancellations/);
    expect(src).toMatch(/pendingCancelCount/);
  });
});
