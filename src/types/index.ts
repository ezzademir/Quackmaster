// Database Types
export interface Supplier {
  id: string;
  name: string;
  contact_person?: string;
  email?: string;
  phone?: string;
  address?: string;
  city?: string;
  country?: string;
  payment_terms?: string;
  created_at: string;
  updated_at: string;
}

export interface RawMaterial {
  id: string;
  name: string;
  description?: string;
  unit_of_measure: string;
  cost_price?: number;
  reorder_level?: number;
  created_at: string;
  updated_at: string;
}

export interface Recipe {
  id: string;
  name: string;
  description?: string;
  target_yield_percentage?: number;
  standard_batch_size: number;
  batch_unit: string;
  created_at: string;
  updated_at: string;
}

export interface RecipeIngredient {
  id: string;
  recipe_id: string;
  raw_material_id: string;
  quantity_required: number;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrder {
  id: string;
  order_number: string;
  supplier_id: string;
  status: 'draft' | 'ordered' | 'received' | 'partial';
  order_date: string;
  expected_delivery_date?: string;
  actual_delivery_date?: string;
  total_amount?: number;
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface PurchaseOrderItem {
  id: string;
  purchase_order_id: string;
  raw_material_id: string;
  quantity_ordered: number;
  quantity_received: number;
  unit_price: number;
  line_total?: number;
  created_at: string;
  updated_at: string;
}

export interface ProductionRun {
  id: string;
  run_number: string;
  recipe_id: string;
  production_date: string;
  planned_output: number;
  actual_output: number;
  yield_percentage?: number;
  status: 'in_progress' | 'completed' | 'cancelled';
  notes?: string;
  created_at: string;
  updated_at: string;
}

export interface ProductionRunMaterial {
  id: string;
  production_run_id: string;
  raw_material_id: string;
  quantity_consumed: number;
  created_at: string;
  updated_at: string;
}

export interface Outlet {
  id: string;
  name: string;
  location_code: string;
  address?: string;
  city?: string;
  country?: string;
  manager_name?: string;
  manager_phone?: string;
  manager_email?: string;
  created_at: string;
  updated_at: string;
}

export interface HubInventory {
  id: string;
  raw_material_id?: string;
  product_batch?: string;
  quantity_on_hand: number;
  reserved_quantity?: number;
  available_quantity?: number;
  last_updated: string;
  created_at: string;
  updated_at: string;
}

export interface OutletInventory {
  id: string;
  outlet_id: string;
  product_batch: string;
  quantity_on_hand: number;
  reserved_quantity?: number;
  available_quantity?: number;
  last_updated: string;
  created_at: string;
  updated_at: string;
}

export interface SupplyOrder {
  id: string;
  supply_order_number: string;
  outlet_id: string;
  dispatch_date: string;
  received_date?: string;
  status: 'pending' | 'dispatched' | 'received';
  total_quantity: number;
  notes?: string;
  created_at: string;
  updated_at: string;
}

// API Response Types
export interface ApiResponse<T> {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
}

// Dashboard KPI Types
export interface DashboardKPIs {
  totalRawMaterialValue: number;
  totalProductStock: number;
  outstandingPurchaseOrders: number;
  averageYield: number;
  lowStockMaterialsCount: number;
  recentActivityCount: number;
}

export interface ActivityLog {
  id: string;
  type: 'purchase' | 'production' | 'supply';
  title: string;
  description: string;
  timestamp: string;
  relatedId: string;
}

export interface PendingRegistration {
  id: string;
  user_id: string;
  email: string;
  full_name: string;
  requested_at: string;
  reviewed_by?: string;
  reviewed_at?: string;
  status: 'pending' | 'approved' | 'rejected';
  rejection_reason?: string;
  created_at: string;
  updated_at: string;
}
