import { describe, expect, it } from 'vitest';
import { scrubError } from './errors.js';

describe('scrubError', () => {
  it('removes every occurrence of each secret from message and code, and drops the original cause chain', () => {
    const original = Object.assign(new Error('auth failed for hunter2; retry with hunter2 (token tok-1)', { cause: new Error('hunter2') }), {
      code: 'E_hunter2',
    });
    const scrubbed = scrubError(original, ['hunter2', undefined, 'tok-1']);
    expect(scrubbed.message).toBe('auth failed for ***; retry with *** (token ***)');
    expect((scrubbed as Error & { code?: string }).code).toBe('E_***');
    expect(scrubbed.cause).toBeUndefined();
    expect(JSON.stringify(scrubbed, Object.getOwnPropertyNames(scrubbed))).not.toContain('hunter2');
  });

  it('wraps non-Error throwables', () => {
    expect(scrubError('boom hunter2', ['hunter2']).message).toBe('boom ***');
  });
});
