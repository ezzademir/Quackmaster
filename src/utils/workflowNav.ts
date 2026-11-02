/** Workflow groups. Each phone tab opens one section. A section shows one primary task, then the rest. */

export interface WorkflowTask {
  path: string;
  label: string;
  detail: string;
  adminOnly?: boolean;
}

export interface WorkflowSection {
  id: 'today' | 'buy' | 'kitchen' | 'outlets' | 'books';
  label: string;
  detail: string;
  home: string;
  tasks: WorkflowTask[];
}

export const WORKFLOW: WorkflowSection[] = [
  {
    id: 'today',
    label: 'Today',
    detail: 'What needs attention right now.',
    home: '/',
    tasks: [{ path: '/', label: 'Overview', detail: 'Open work across the hub and the outlets.' }],
  },
  {
    id: 'buy',
    label: 'Buy',
    detail: 'Order from suppliers, check the delivery in, then record the bill.',
    home: '/buy',
    tasks: [
      { path: '/procurement', label: 'Purchase orders', detail: 'Raise an order and follow it until it is received.' },
      { path: '/receiving', label: 'Receiving', detail: 'Check a delivery against the order.' },
      { path: '/bills', label: 'Bills', detail: 'Record a supplier bill, a payment, or a void.', adminOnly: true },
      { path: '/suppliers', label: 'Suppliers', detail: 'Who you buy from.' },
    ],
  },
  {
    id: 'kitchen',
    label: 'Kitchen',
    detail: 'Turn what you bought into food, and see what is left.',
    home: '/kitchen',
    tasks: [
      { path: '/production', label: 'Production', detail: 'Plan and record a cook.' },
      { path: '/inventory', label: 'Inventory', detail: 'What is on hand at the hub.' },
      { path: '/genealogy', label: 'Lot trace', detail: 'Follow one lot from delivery to outlet.' },
    ],
  },
  {
    id: 'outlets',
    label: 'Outlets',
    detail: 'Send food out, then record what each outlet sold, wasted, or counted.',
    home: '/outlets',
    tasks: [
      { path: '/distribution', label: 'Distribution', detail: 'Send a batch to an outlet.' },
      { path: '/sales', label: 'Outlet sales', detail: 'What an outlet sold.' },
      { path: '/waste', label: 'Waste', detail: 'What was thrown away.' },
      { path: '/stock-take', label: 'Stock take', detail: 'Count what is still there.' },
    ],
  },
  {
    id: 'books',
    label: 'Books',
    detail: 'Cost, audit, and the accounts only an admin keeps.',
    home: '/books',
    tasks: [
      { path: '/costing', label: 'Costing', detail: 'Food cost and prices that jumped.', adminOnly: true },
      { path: '/audit', label: 'Stock audit', detail: 'Where the stock numbers disagree.', adminOnly: true },
      { path: '/reconciliation', label: 'Reconciliation', detail: 'Match the books to the count.', adminOnly: true },
      { path: '/pos-compare', label: 'POS compare', detail: 'Compare the till with what was supplied.', adminOnly: true },
      { path: '/users', label: 'Users', detail: 'Roles and who can buy for which brand.', adminOnly: true },
      { path: '/ledger', label: 'Change log', detail: 'Who changed what.', adminOnly: true },
      { path: '/settings', label: 'Settings', detail: 'How the system behaves.', adminOnly: true },
    ],
  },
];

export function visibleSections(isAdmin: boolean): WorkflowSection[] {
  return WORKFLOW.map((section) => ({
    ...section,
    tasks: section.tasks.filter((task) => isAdmin || !task.adminOnly),
  })).filter((section) => section.tasks.length > 0);
}

export function crumbForPath(pathname: string): { section: string; page: string } {
  if (pathname === '/') return { section: 'Today', page: 'Overview' };
  for (const section of WORKFLOW) {
    if (pathname === section.home) return { section: section.label, page: section.label };
    const task = section.tasks.find(
      (item) => item.path !== '/' && (pathname === item.path || pathname.startsWith(`${item.path}/`)),
    );
    if (task) return { section: section.label, page: task.label };
  }
  return { section: 'Quackmaster', page: 'Quackmaster' };
}

export function sectionIsActive(pathname: string, section: WorkflowSection): boolean {
  if (section.home === '/') return pathname === '/';
  if (pathname === section.home) return true;
  return section.tasks.some(
    (task) => task.path !== '/' && (pathname === task.path || pathname.startsWith(`${task.path}/`)),
  );
}
