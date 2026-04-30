/**
 * Input Validation Utilities
 * Ensures data integrity at all boundaries
 */

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
}

// ---- Common Validators ----

export function validateRequired(value: unknown, fieldName: string): ValidationError | null {
  if (!value || (typeof value === 'string' && !value.trim())) {
    return { field: fieldName, message: `${fieldName} is required` };
  }
  return null;
}

export function validateEmail(email: string): ValidationError | null {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return { field: 'email', message: 'Invalid email format' };
  }
  return null;
}

export function validateNumber(value: unknown, fieldName: string, minValue?: number, maxValue?: number): ValidationError | null {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  
  if (typeof num !== 'number' || isNaN(num)) {
    return { field: fieldName, message: `${fieldName} must be a valid number` };
  }

  if (minValue !== undefined && num < minValue) {
    return { field: fieldName, message: `${fieldName} must be at least ${minValue}` };
  }

  if (maxValue !== undefined && num > maxValue) {
    return { field: fieldName, message: `${fieldName} cannot exceed ${maxValue}` };
  }

  return null;
}

export function validatePositiveNumber(value: unknown, fieldName: string): ValidationError | null {
  const num = typeof value === 'string' ? parseFloat(value) : value;
  
  if (typeof num !== 'number' || isNaN(num) || num <= 0) {
    return { field: fieldName, message: `${fieldName} must be a positive number` };
  }
  
  return null;
}

export function validateUrl(url: string): ValidationError | null {
  try {
    new URL(url);
    return null;
  } catch {
    return { field: 'url', message: 'Invalid URL format' };
  }
}

// ---- Domain-Specific Validators ----

export function validateSupplier(data: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  const nameErr = validateRequired(data.name, 'Supplier name');
  if (nameErr) errors.push(nameErr);

  if (data.email && typeof data.email === 'string') {
    const emailErr = validateEmail(data.email);
    if (emailErr) errors.push(emailErr);
  }

  if (data.phone && typeof data.phone === 'string' && data.phone.trim().length < 5) {
    errors.push({ field: 'phone', message: 'Phone number must be at least 5 digits' });
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function validateRawMaterial(data: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  const nameErr = validateRequired(data.name, 'Material name');
  if (nameErr) errors.push(nameErr);

  const unitErr = validateRequired(data.unit_of_measure, 'Unit of measure');
  if (unitErr) errors.push(unitErr);

  if (data.cost_price !== undefined) {
    const costErr = validateNumber(data.cost_price, 'Cost price', 0);
    if (costErr) errors.push(costErr);
  }

  if (data.reorder_level !== undefined) {
    const reorderErr = validateNumber(data.reorder_level, 'Reorder level', 0);
    if (reorderErr) errors.push(reorderErr);
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function validatePurchaseOrder(data: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  const supplierErr = validateRequired(data.supplier_id, 'Supplier');
  if (supplierErr) errors.push(supplierErr);

  if (data.expected_delivery_date && typeof data.expected_delivery_date === 'string') {
    const date = new Date(data.expected_delivery_date);
    if (isNaN(date.getTime())) {
      errors.push({ field: 'expected_delivery_date', message: 'Invalid delivery date format' });
    } else if (date < new Date()) {
      errors.push({ field: 'expected_delivery_date', message: 'Delivery date cannot be in the past' });
    }
  }

  if (data.total_amount !== undefined) {
    const amountErr = validateNumber(data.total_amount, 'Total amount', 0);
    if (amountErr) errors.push(amountErr);
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function validatePurchaseOrderItem(data: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  const materialErr = validateRequired(data.raw_material_id, 'Material');
  if (materialErr) errors.push(materialErr);

  const qtyErr = validatePositiveNumber(data.quantity_ordered, 'Quantity');
  if (qtyErr) errors.push(qtyErr);

  const priceErr = validateNumber(data.unit_price, 'Unit price', 0);
  if (priceErr) errors.push(priceErr);

  // Ensure quantity_received doesn't exceed quantity_ordered
  const qtyReceived = typeof data.quantity_received === 'number' ? data.quantity_received : 0;
  const qtyOrdered = typeof data.quantity_ordered === 'number' ? data.quantity_ordered : 0;
  if (qtyReceived > qtyOrdered) {
    errors.push({
      field: 'quantity_received',
      message: 'Quantity received cannot exceed quantity ordered',
    });
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function validateProductionRun(data: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  const recipeErr = validateRequired(data.recipe_id, 'Recipe');
  if (recipeErr) errors.push(recipeErr);

  const dateErr = validateRequired(data.production_date, 'Production date');
  if (dateErr) errors.push(dateErr);

  const plannedErr = validatePositiveNumber(data.planned_output, 'Planned output');
  if (plannedErr) errors.push(plannedErr);

  if (data.actual_output !== undefined && data.actual_output !== null) {
    const actualErr = validateNumber(data.actual_output, 'Actual output', 0);
    if (actualErr) errors.push(actualErr);
  }

  if (data.yield_percentage !== undefined) {
    const yieldErr = validateNumber(data.yield_percentage, 'Yield percentage', 0, 100);
    if (yieldErr) errors.push(yieldErr);
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function validateOutlet(data: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  const nameErr = validateRequired(data.name, 'Outlet name');
  if (nameErr) errors.push(nameErr);

  const codeErr = validateRequired(data.location_code, 'Location code');
  if (codeErr) errors.push(codeErr);

  if (data.manager_email && typeof data.manager_email === 'string') {
    const emailErr = validateEmail(data.manager_email);
    if (emailErr) errors.push(emailErr);
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function validateSupplyOrder(data: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  const outletErr = validateRequired(data.outlet_id, 'Outlet');
  if (outletErr) errors.push(outletErr);

  const dateErr = validateRequired(data.supply_date ?? data.dispatch_date, 'Supply date');
  if (dateErr) errors.push(dateErr);

  const qtyErr = validatePositiveNumber(data.total_quantity, 'Total quantity');
  if (qtyErr) errors.push(qtyErr);

  return {
    isValid: errors.length === 0,
    errors,
  };
}

export function validateInventoryAdjustment(data: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  const typeErr = validateRequired(data.adjustment_type, 'Adjustment type');
  if (typeErr) errors.push(typeErr);

  if (data.adjustment_type && !['addition', 'deduction'].includes(data.adjustment_type as string)) {
    errors.push({
      field: 'adjustment_type',
      message: 'Adjustment type must be "addition" or "deduction"',
    });
  }

  const qtyErr = validatePositiveNumber(data.adjusted_quantity, 'Adjusted quantity');
  if (qtyErr) errors.push(qtyErr);

  const reasonErr = validateRequired(data.adjustment_reason, 'Adjustment reason');
  if (reasonErr) errors.push(reasonErr);

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Format validation errors for display
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.field}: ${e.message}`).join('\n');
}
