// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

function Smoke() {
  return <p>jsdom smoke</p>;
}

describe('jsdom render smoke', () => {
  it('renders a React element', () => {
    render(<Smoke />);
    expect(screen.getByText('jsdom smoke')).toBeTruthy();
  });
});
