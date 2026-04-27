# Business Logic System Enhancements

## Overview

This document summarizes comprehensive business logic improvements to the ERP system, addressing data validation, inventory management, approval workflows, error handling, and quality control.

---

## ✅ Completed Improvements

### 1. **Input Validation System** (`src/utils/validation.ts`)

**Purpose:** Ensure data integrity at all system boundaries

**Key Features:**
- Generic validators: `validateRequired()`, `validateEmail()`, `validateNumber()`, `validatePositiveNumber()`
- Domain-specific validators:
  - `validateSupplier()` — validates contact info, payment terms
  - `validateRawMaterial()` — validates cost, reorder levels
  - `validatePurchaseOrder()` — validates dates, amounts, supplier
  - `validatePurchaseOrderItem()` — ensures qty_received ≤ qty_ordered
  - `validateProductionRun()` — validates yield %, output quantities
  - `validateOutlet()` — validates location codes, contact info
  - `validateSupplyOrder()` — validates outlet, dates, quantities
  - `validateInventoryAdjustment()` — validates adjustment type & reason

**Usage:**
```typescript
import { validatePurchaseOrder, formatValidationErrors } from '@/utils/validation';

const validation = validatePurchaseOrder({ supplier_id, total_amount });
if (!validation.isValid) {
  showError(formatValidationErrors(validation.errors));
  return;
}
```

---

### 2. **Inventory Reservation & Locking** (`src/utils/inventory.ts`)

**Purpose:** Prevent overselling in concurrent supply orders

**Key Functions:**
- `checkInventoryAvailability()` — Read-only availability check before reservation
- `reserveInventory()` — Atomic lock on inventory (increment reserved_quantity)
- `releaseReservation()` — Unlock inventory when order cancelled
- `fulfillReservation()` — Convert reservation to actual deduction
- `getInventoryStatus()` — Get inventory with utilization metrics
- `batchCheckInventoryAvailability()` — Pre-validate multiple items

**How It Works:**
1. When supply order is created, inventory is *reserved* (locked)
2. Reserved quantity is subtracted from available quantity
3. Multiple concurrent orders can't exceed hub stock
4. Reservation converts to fulfillment when order dispatched
5. Cancelled orders release the reservation

**Usage:**
```typescript
import { checkInventoryAvailability, reserveInventory } from '@/utils/inventory';

// Check before creating order
const check = await checkInventoryAvailability(inventoryId, 100);
if (!check.canReserve) return showError(check.message);

// Reserve inventory
const result = await reserveInventory({
  hubInventoryId: inventoryId,
  quantity: 100,
  referenceType: 'supply_order',
  referenceId: orderId,
});
```

---

### 3. **Approval Workflow State Machine** (`src/utils/approval.ts`)

**Purpose:** Formalize user registration approval with clear state transitions

**States:**
- `pending` → `approved` (admin only)
- `pending` → `rejected` (admin only, requires reason)
- `rejected` → `pending` (admin can re-open for review)

**Key Functions:**
- `isTransitionAllowed()` — Validate role-based transitions
- `validateApprovalAction()` — Comprehensive action validation
- `applyApprovalAction()` — Update state with timestamp & reviewer
- `isApprovalFinal()` — Check if transition possible
- `getAvailableNextStates()` — Show allowed next states for user role

**Usage:**
```typescript
import { validateApprovalAction, applyApprovalAction } from '@/utils/approval';

const validation = validateApprovalAction(
  'pending',
  { action: 'reject', reviewerId, rejectionReason },
  'admin'
);
if (!validation.valid) return showErrors(validation.errors);

const newState = applyApprovalAction(currentState, action);
```

---

### 4. **Error Handling & Retry Logic** (`src/utils/errorHandling.ts`)

**Purpose:** Graceful recovery from transient failures

**Key Classes & Functions:**
- `BusinessLogicError` — Custom error with context
- `isRetryableError()` — Classify errors as transient vs permanent
- `calculateBackoffDelay()` — Exponential backoff with jitter
- `retryWithBackoff()` — Retry operation with backoff
- `retryMultipleOperations()` — Concurrent retries for batch operations
- `CircuitBreaker` — Prevent cascading failures
- `buildErrorContext()` — Structured error logging
- `formatErrorForLogging()` — Human-readable error reports

**Usage:**
```typescript
import { retryWithBackoff, BusinessLogicError } from '@/utils/errorHandling';

try {
  await retryWithBackoff(() => supabase.from('...').insert(...), {
    maxAttempts: 3,
    initialDelayMs: 100,
  });
} catch (err) {
  throw new BusinessLogicError(
    'Failed to create order',
    'CREATE_ORDER_FAILED',
    true // retryable
  );
}
```

---

### 5. **Quality Control & Yield Validation** (`src/utils/qcValidation.ts`)

**Purpose:** Ensure production meets acceptance criteria before inventory posting

**Key Functions:**
- `calculateYield()` — Compute yield percentage
- `calculateVariance()` — Compare actual vs target yield
- `evaluateProductionQC()` — Full QC assessment with status
- `determineQCActions()` — Map QC result → allowed next actions
- `getStandardQCCriteria()` — Product-type QC thresholds
- `analyzeQCTrend()` — Historical trend analysis across batches
- `createQCReport()` — Audit trail report

**QC Statuses:**
- ✅ `acceptable` — Passes all criteria, post to inventory
- ⚠️ `warning` — Variance high, needs review/approval
- ❌ `rejected` — Below minimums, investigate root cause

**Usage:**
```typescript
import { evaluateProductionQC, determineQCActions } from '@/utils/qcValidation';

const qcResult = evaluateProductionQC(productionData, qcCriteria);
const actions = determineQCActions(qcResult, isAdmin);

if (!qcResult.passed) {
  return showError(qcResult.message);
}

// Post batch to inventory...
```

---

### 6. **Enhanced Procurement** (`src/pages/Procurement.tsx`)

**Improvements:**
- ✅ All supplier form inputs validated using `validateSupplier()`
- ✅ Material inputs validated with `validateRawMaterial()`
- ✅ PO header validated with `validatePurchaseOrder()`
- ✅ Each line item validated with `validatePurchaseOrderItem()`
- ✅ All saves wrapped with `retryWithBackoff()` for resilience
- ✅ Ledger entries logged for all mutations
- ✅ Receive quantities validated: qty_received ≤ qty_ordered
- ✅ Inventory upserts check reserved_quantity when updating available
- ✅ Error messages displayed with context icons

**Error Handling:**
```typescript
try {
  const validation = validatePurchaseOrderItem({...});
  if (!validation.isValid) {
    setError(formatValidationErrors(validation.errors));
    return;
  }
  
  await retryWithBackoff(() => {
    // Database operation
  });
} catch (err) {
  setError(err instanceof Error ? err.message : 'Unknown error');
}
```

---

### 7. **Production Service** (`src/utils/productionService.ts`)

**Purpose:** Complete production runs with QC validation and inventory posting

**Key Functions:**
- `completeProductionRun()` — Full production completion workflow:
  1. Load recipe & QC criteria
  2. Evaluate yield vs standards
  3. Generate QC report
  4. If rejected: return error, don't post to inventory
  5. If warning & non-admin: require approval
  6. If approved: update status, create batch, deduct materials
- `rejectProductionRun()` — Manual QC rejection by inspector

**Workflow:**
```
Production Run Completed
  ↓
[QC Evaluation]
  ├→ Acceptable → Post to Inventory ✅
  ├→ Warning → Require Admin Approval ⚠️
  └→ Rejected → Investigate, Don't Post ❌
```

---

### 8. **Distribution Service** (`src/utils/distributionService.ts`)

**Purpose:** Supply orders with atomic inventory reservations

**Key Functions:**
- `createSupplyOrder()` — Pre-check all items available, reserve atomically
- `dispatchSupplyOrder()` — Update status to dispatched
- `confirmSupplyOrderReceipt()` — Update status to received
- `cancelSupplyOrder()` — Release all reservations

**Workflow:**
```
Supply Order Created
  ↓
[Pre-Check Availability]
  ├→ All Available → Create Order + Reserve ✅
  └→ Short → Return Errors, Don't Create ❌
  ↓
Status: pending → dispatched → received
```

---

### 9. **Enhanced Pending Approval** (`src/pages/PendingApproval.tsx`)

**Improvements:**
- ✅ Formal approval workflow state machine integrated
- ✅ Display rejection reasons if rejected
- ✅ Show review dates and reviewer info
- ✅ Log approval to ledger for audit trail
- ✅ Animated status indicators (clock for pending, alert for rejected)

---

### 10. **Inventory Adjustment Service** (`src/utils/adjustmentService.ts`)

**Purpose:** Handle inventory discrepancies (damage, expiry, stock variance)

**Key Functions:**
- `createInventoryAdjustment()` — Draft adjustment (pending approval)
- `applyInventoryAdjustment()` — Approve and execute adjustment
- `rejectInventoryAdjustment()` — Deny adjustment request
- `getPendingAdjustments()` — Admin workflow list
- `getAdjustmentHistory()` — Audit trail per inventory item
- `getAdjustmentStats()` — Trend analysis (e.g., damage rate, loss tracking)

**Adjustment Reasons:**
- `stock_count_variance` — Physical count differs from system
- `damage` — Goods damaged in handling
- `expiry` — Goods expired
- `theft` — Suspected loss
- `quality_issue` — QC failure
- `recount` — Recount correction
- `supplier_return` — Goods returned to supplier
- `other` — Other adjustments

---

## 🏗️ Architecture & Principles

### Data Consistency
- **Validation at boundary:** All external inputs validated before database operations
- **Transaction safety:** Multi-step operations wrapped with retry logic
- **Atomic reservations:** Inventory locking prevents overselling
- **Immutable ledger:** All mutations logged for audit trail

### Error Handling
- **Retry transient errors:** Network, timeout, rate-limit errors automatically retry
- **Circuit breaker:** Cascade failures prevented after threshold
- **Context preservation:** Errors include operation, entity, user, timestamp
- **User feedback:** Validation errors formateed for display

### State Management
- **Explicit transitions:** All state changes validated
- **Role-based access:** Approval workflows enforced per user role
- **Final states:** Some transitions are terminal (e.g., `received` supply order)
- **Audit trail:** Every state change logged with reviewer & reason

---

## 📋 Database Schema Requirements

To support these workflows, your database should have:

### Tables
- `inventory_adjustments` — Track pending/approved inventory changes
- `supply_order_reservations` — Track reserved inventory per order (optional, for audit)

### Functions (Recommended)
- `reserve_inventory(p_hub_inventory_id, p_quantity, p_reference_type, p_reference_id)` — Atomic reservation
- `release_inventory_reservation(p_hub_inventory_id, p_quantity, p_reference_id)` — Atomic release
- `fulfill_inventory_reservation(p_hub_inventory_id, p_quantity, p_reference_id)` — Atomic fulfillment

### Columns (Verify Exist)
- `hub_inventory.reserved_quantity` — Qty locked for pending orders
- `hub_inventory.available_quantity` — qty_on_hand - reserved_quantity
- `production_runs.status` — 'in_progress' | 'completed' | 'cancelled'
- `pending_registrations.rejection_reason` — Why user was rejected
- `pending_registrations.reviewed_by` — Admin who reviewed
- `pending_registrations.reviewed_at` — When review occurred

---

## 🚀 Usage Examples

### Complete Purchase Order Reception
```typescript
import { retryWithBackoff } from '@/utils/errorHandling';
import { validatePurchaseOrderItem } from '@/utils/validation';

async function receivePoItems(items) {
  for (const item of items) {
    // Validate
    const validation = validatePurchaseOrderItem({
      quantity_received: item.receivedQty,
      quantity_ordered: item.orderedQty,
      unit_price: item.price,
    });
    if (!validation.isValid) throw new Error('Invalid item');
    
    // Update with retry
    await retryWithBackoff(() =>
      supabase
        .from('purchase_order_items')
        .update({ quantity_received: item.receivedQty })
        .eq('id', item.id)
    );
  }
}
```

### Complete Production with QC
```typescript
import { completeProductionRun } from '@/utils/productionService';

const result = await completeProductionRun({
  productionRunId: runId,
  recipeId,
  plannedOutput: 1000,
  actualOutput: 945,
  targetYield: 95,
  isAdmin: userRole === 'admin',
});

if (!result.success) {
  showError(result.error);
  return;
}

if (result.qcReport.actions.requiresApproval) {
  showWarning('Requires admin approval before inventory posting');
  return;
}

showSuccess('Production completed, batch posted to inventory');
```

### Create Supply Order with Reservations
```typescript
import { createSupplyOrder } from '@/utils/distributionService';

const result = await createSupplyOrder({
  outletId,
  dispatchDate,
  items: [
    { hubInventoryId: inv1, quantity: 50, productBatch: 'BATCH-001' },
    { hubInventoryId: inv2, quantity: 30, productBatch: 'BATCH-002' },
  ],
});

if (!result.success) {
  result.errors.forEach(err => showError(err));
  result.reservations
    .filter(r => !r.reserved)
    .forEach(r => showWarning(`Failed to reserve ${r.item.productBatch}: ${r.error}`));
  return;
}

showSuccess(`Supply order created with ${result.reservations.length} items reserved`);
```

---

## 🧪 Testing Recommendations

1. **Validation Tests:** Test each validator with valid/invalid data
2. **Concurrent Reservations:** Create 2+ supply orders simultaneously to verify reservation lock
3. **QC Workflows:** Test accepted/warning/rejected paths
4. **Retry Logic:** Simulate network failures to verify backoff
5. **State Transitions:** Test invalid approval transitions
6. **Audit Trail:** Verify all ledger entries created for mutations

---

## 📝 Migration Checklist

- [ ] Create `inventory_adjustments` table
- [ ] Add `reserved_quantity` column to `hub_inventory` if not present
- [ ] Add `available_quantity` (computed or stored) to `hub_inventory`
- [ ] Create database functions for atomic reservation/release/fulfill
- [ ] Add `rejection_reason`, `reviewed_by`, `reviewed_at` to `pending_registrations`
- [ ] Test validation utilities with sample data
- [ ] Test retry logic with intentional failures
- [ ] Verify ledger entries for all module operations
- [ ] Update UI pages to use new services
- [ ] Document approval workflow for end users

---

## ✨ Future Enhancements

1. **Notification System:** Alert users when approvals pending
2. **Batch Operations:** Bulk create/approve adjustments
3. **Advanced QC:** Multiple QC inspectors, weighted scoring
4. **Predictive Inventory:** Forecast low stock based on usage trends
5. **Analytics Dashboard:** QC metrics, adjustment trends, reservation utilization
6. **Approval Escalation:** Auto-escalate pending approvals after N days
7. **Integration Tests:** Automated end-to-end workflows

---

## 📚 File Structure

```
src/utils/
  ├── validation.ts           # Input validation (5 KB)
  ├── inventory.ts            # Reservation locking (4 KB)
  ├── approval.ts             # State machine (3 KB)
  ├── errorHandling.ts        # Retry + circuit breaker (6 KB)
  ├── qcValidation.ts         # QC evaluation (5 KB)
  ├── productionService.ts    # Production workflow (5 KB)
  ├── distributionService.ts  # Supply orders (5 KB)
  ├── adjustmentService.ts    # Inventory adjustments (7 KB)
  └── (existing utils...)

src/pages/
  ├── Procurement.tsx         # Enhanced with validation, retry
  ├── Production.tsx          # Ready to integrate productionService
  ├── Distribution.tsx        # Ready to integrate distributionService
  ├── PendingApproval.tsx     # Enhanced with approval workflow
  └── (other pages...)
```

---

## 💾 Summary of Improvements

| Area | Before | After | Benefit |
|------|--------|-------|---------|
| **Input Validation** | Basic required checks | Comprehensive domain validators | Prevent invalid data at boundary |
| **Inventory Conflicts** | No locking; overselling possible | Atomic reservations | Concurrent orders safe |
| **Approval Logic** | Implicit; inconsistent | State machine with roles | Formal, auditable workflow |
| **Error Recovery** | Fail immediately | Exponential backoff retry | Transient failures recoverable |
| **QC Process** | Manual, inconsistent | Standardized criteria & thresholds | Consistent quality gates |
| **Procurement** | No validation; basic logging | Full validation + ledger | Audit trail + data integrity |
| **Production** | Output to inventory unclear | Explicit QC → inventory path | Quality assured posting |
| **Distribution** | No reservation logic | Atomic with pre-check | Overselling prevented |
| **Inventory Adjustments** | Ad-hoc, no approval | Formal workflow with audit | Controllable discrepancies |

---

**All utilities are fully typed with TypeScript for IDE support and compile-time safety.**
