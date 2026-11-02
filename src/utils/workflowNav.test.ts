import { describe, expect, it } from 'vitest';
import { crumbForPath, sectionIsActive, visibleSections, WORKFLOW } from './workflowNav';

describe('workflowNav', () => {
  it('gives an admin five sections in buy, kitchen, outlets, books order', () => {
    expect(visibleSections(true).map((section) => section.id)).toEqual(['today', 'buy', 'kitchen', 'outlets', 'books']);
  });

  it('hides the books and bills from staff', () => {
    const staff = visibleSections(false);
    expect(staff.map((section) => section.id)).toEqual(['today', 'buy', 'kitchen', 'outlets']);
    expect(staff.find((section) => section.id === 'buy')?.tasks.map((task) => task.path)).not.toContain('/bills');
    expect(staff.find((section) => section.id === 'buy')?.tasks.map((task) => task.path)).toContain('/procurement');
  });

  it('names the section and the task for a deep link', () => {
    expect(crumbForPath('/costing')).toEqual({ section: 'Books', page: 'Costing' });
    expect(crumbForPath('/procurement/new')).toEqual({ section: 'Buy', page: 'Purchase orders' });
    expect(crumbForPath('/buy')).toEqual({ section: 'Buy', page: 'Buy' });
  });

  it('keeps the Buy tab active while a purchase order is open', () => {
    const buy = WORKFLOW.find((section) => section.id === 'buy');
    expect(buy).toBeTruthy();
    expect(sectionIsActive('/procurement', buy!)).toBe(true);
    expect(sectionIsActive('/kitchen', buy!)).toBe(false);
    expect(sectionIsActive('/', WORKFLOW[0])).toBe(true);
  });
});
