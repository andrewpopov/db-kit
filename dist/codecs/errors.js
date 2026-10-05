import { DbKitError } from '../errors.js';
/** A value no codec can carry across engines. Names table.column and the reason; never the value itself. */
export class CodecError extends DbKitError {
    table;
    column;
    reason;
    constructor(code, table, column, reason) {
        super(code, `${table}.${column}: ${reason}`);
        this.name = 'CodecError';
        this.table = table;
        this.column = column;
        this.reason = reason;
    }
}
