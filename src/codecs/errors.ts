import { DbKitError } from '../errors.js';

/** A value no codec can carry across engines. Names table.column and the reason; never the value itself. */
export class CodecError extends DbKitError {
  readonly table: string;
  readonly column: string;
  readonly reason: string;

  constructor(code: 'CODEC_NULL' | 'CODEC_INVALID' | 'CODEC_LOSSY', table: string, column: string, reason: string) {
    super(code, `${table}.${column}: ${reason}`);
    this.name = 'CodecError';
    this.table = table;
    this.column = column;
    this.reason = reason;
  }
}
