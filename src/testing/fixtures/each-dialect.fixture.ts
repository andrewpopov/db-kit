import { expect, it } from 'vitest';
import { describeEachDialect } from '../dialects.js';

// Run only by testing.test.ts, in a child vitest, to see how describeEachDialect behaves when Postgres cannot start.
describeEachDialect(
  'fixture',
  ({ dialect, open }) => {
    it('opens its dialect', () => {
      expect(open().dialect).toBe(dialect);
    });
  },
  { postgres: { locale: 'no_such_locale_xyz' } },
);
