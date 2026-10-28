// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { requestCancelPurchaseOrder, listAllCancelRequests, listOwnCancelRequests } = vi.hoisted(() => ({
  requestCancelPurchaseOrder: vi.fn(),
  listAllCancelRequests: vi.fn(),
  listOwnCancelRequests: vi.fn(),
}));

vi.mock('../utils/poCancelRpc', () => ({
  requestCancelPurchaseOrder,
  listAllCancelRequests,
  listOwnCancelRequests,
}));

import { PoCancelPanel } from './PoCancelPanel';

const PO = {
  id: 'po-1',
  order_number: 'PO-0001',
  status: 'received',
  items: [{ quantity_received: 2 }],
};

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    purchase_order_id: 'po-1',
    requested_by: 'buyer-qt',
    requested_at: '2026-10-20T02:00:00.000Z',
    reason: 'wrong qty',
    status: 'pending',
    decided_by: null,
    decided_at: null,
    decision_reason: null,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  requestCancelPurchaseOrder.mockReset();
  listAllCancelRequests.mockReset();
  listOwnCancelRequests.mockReset();
  listOwnCancelRequests.mockResolvedValue({ data: [], error: null });
  listAllCancelRequests.mockResolvedValue({ data: [], error: null });
  vi.stubGlobal('confirm', vi.fn(() => true));
});

describe('PoCancelPanel procurement', () => {
  it('shows Request cancellation and not Cancel order; submits the request RPC', async () => {
    requestCancelPurchaseOrder.mockResolvedValue({ data: { success: true, status: 'pending', request_id: 'r2' }, error: null });
    render(<PoCancelPanel po={PO} role="procurement" uid="buyer-qt" />);
    await waitFor(() => expect(listOwnCancelRequests).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));
    const box = screen.getByLabelText('Cancellation reason');
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: '  please cancel  ' } });
    expect(screen.getByText('13/1000')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() =>
      expect(requestCancelPurchaseOrder).toHaveBeenCalledWith('po-1', 'please cancel')
    );
  });

  it('shows a pending notice and hides the request button', async () => {
    listOwnCancelRequests.mockResolvedValue({ data: [pendingRow()], error: null });
    render(<PoCancelPanel po={PO} role="procurement" uid="buyer-qt" />);
    await waitFor(() => expect(screen.getByText(/Cancellation requested on/)).toBeTruthy());
    expect(screen.getByText(/Your reason: wrong qty/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Request cancellation' })).toBeNull();
  });

  it('shows a rejected notice and lets the user request again', async () => {
    listOwnCancelRequests.mockResolvedValue({
      data: [
        pendingRow({
          status: 'rejected',
          decided_at: '2026-10-21T02:00:00.000Z',
          decision_reason: 'keep it',
        }),
      ],
      error: null,
    });
    render(<PoCancelPanel po={PO} role="procurement" uid="buyer-qt" />);
    await waitFor(() => expect(screen.getByText(/Cancellation rejected on/)).toBeTruthy());
    expect(screen.getByText(/keep it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Request cancellation' })).toBeTruthy();
  });

  it('shows message, DETAIL, HINT and bill numbers inline', async () => {
    requestCancelPurchaseOrder.mockResolvedValue({
      data: null,
      error: {
        message: 'bills_on_po',
        details: 'Handle the bill through accounting first. Nothing was cancelled.',
        hint: '["G1-1"]',
      },
    });
    render(<PoCancelPanel po={PO} role="procurement" uid="buyer-qt" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request cancellation' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: 'billed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/Handle the bill through accounting first/);
    expect(alert.textContent).toMatch(/DETAIL:/);
    expect(alert.textContent).toMatch(/HINT:/);
    expect(alert.textContent).toMatch(/G1-1/);
  });

  it('blocks an empty reason and a 1001-character reason on the client', async () => {
    render(<PoCancelPanel po={PO} role="procurement" uid="buyer-qt" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request cancellation' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(screen.getByText('A reason is required')).toBeTruthy();
    expect(requestCancelPurchaseOrder).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: 'x'.repeat(1001) } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    expect(screen.getByText('Reason must be at most 1000 characters')).toBeTruthy();
    expect(requestCancelPurchaseOrder).not.toHaveBeenCalled();
  });

  it('does not fire a second RPC while a submit is in flight', async () => {
    let resolveRpc: (value: { data: unknown; error: null }) => void = () => {};
    requestCancelPurchaseOrder.mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = resolve;
      })
    );
    render(<PoCancelPanel po={PO} role="procurement" uid="buyer-qt" />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request cancellation' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }));
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: 'please cancel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit request' }));
    await waitFor(() => expect(requestCancelPurchaseOrder).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Submitting…' }));
    expect(requestCancelPurchaseOrder).toHaveBeenCalledTimes(1);
    resolveRpc({ data: { success: true, status: 'pending', request_id: 'r2' }, error: null });
    await waitFor(() => expect(requestCancelPurchaseOrder).toHaveBeenCalledTimes(1));
  });
});

describe('PoCancelPanel admin', () => {
  it('sends a mandatory reason through requestCancelPurchaseOrder', async () => {
    requestCancelPurchaseOrder.mockResolvedValue({
      data: { success: true, po_kept_as_cancelled: true },
      error: null,
    });
    const onCancelled = vi.fn();
    render(<PoCancelPanel po={PO} role="admin" uid="admin-1" onCancelled={onCancelled} />);
    await waitFor(() => expect(listAllCancelRequests).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    fireEvent.change(screen.getByLabelText('Cancellation reason'), { target: { value: 'admin reason' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel order' }));
    await waitFor(() => expect(requestCancelPurchaseOrder).toHaveBeenCalledWith('po-1', 'admin reason'));
    const confirmText = String(vi.mocked(confirm).mock.calls[0][0]);
    expect(confirmText).toMatch(/marked cancelled/);
    expect(confirmText).not.toMatch(/delete/i);
    expect(onCancelled).toHaveBeenCalled();
  });

  it('hides direct cancel while a request is pending', async () => {
    listAllCancelRequests.mockResolvedValue({ data: [pendingRow()], error: null });
    render(<PoCancelPanel po={PO} role="admin" uid="admin-1" />);
    await waitFor(() => expect(screen.getByText('Decide the pending request first')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
  });

  it('tells a requester-turned-admin that another admin must decide', async () => {
    listAllCancelRequests.mockResolvedValue({ data: [pendingRow({ requested_by: 'admin-1' })], error: null });
    render(<PoCancelPanel po={PO} role="admin" uid="admin-1" />);
    await waitFor(() => expect(screen.getByText('Another admin must decide this')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Cancel order' })).toBeNull();
  });
});

describe('Procurement.tsx wiring contract', () => {
  const files = import.meta.glob('../pages/Procurement.tsx', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>;
  const src = Object.values(files)[0] ?? '';

  it('wires the panel and does not render the old cancel RPC button for procurement', () => {
    expect(src).toMatch(/PoCancelPanel/);
    expect(src).toMatch(/purchaseOrderCanSimpleDelete\(po\) && onDelete/);
    expect(src).not.toMatch(/purchaseOrderUseCancelRpc\(po\) \? 'Cancel order' : 'Delete order'/);
    expect(src).not.toMatch(/cancel_purchase_order/);
    expect(src).not.toMatch(/reverse bill/i);
  });
});
