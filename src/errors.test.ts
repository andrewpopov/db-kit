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

  it('scrubs name, stack and every own string property, not just message and code', () => {
    const original = Object.assign(new Error('boom'), {
      name: 'Err-hunter2',
      detail: 'Key (pw)=(hunter2) is bad',
      hint: 'try hunter2',
      count: 3,
    });
    original.stack = 'Err-hunter2: boom\n    at connect (hunter2.js:1:1)';
    const scrubbed = scrubError(original, ['hunter2']) as Error & Record<string, unknown>;
    expect(scrubbed.name).toBe('Err-***');
    expect(scrubbed.stack).not.toContain('hunter2');
    expect(scrubbed.detail).toBe('Key (pw)=(***) is bad');
    expect(scrubbed.hint).toBe('try ***');
    expect(scrubbed.count).toBeUndefined();
    expect(JSON.stringify(scrubbed, Object.getOwnPropertyNames(scrubbed))).not.toContain('hunter2');
  });
});
