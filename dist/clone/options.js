import { refuse } from './errors.js';
/** A numeric option that is not what it must be is refused by name, before anything is read or written: `fetchRows: 0` would make every verification compare empty to empty. */
export function positiveInteger(name, value) {
    if (value !== undefined && !(Number.isInteger(value) && value > 0))
        refuse({ code: 'invalid-option', object: name });
}
/** Finite and not negative (a duration that may be fractional or zero). */
export function nonNegativeNumber(name, value) {
    if (value !== undefined && !(Number.isFinite(value) && value >= 0))
        refuse({ code: 'invalid-option', object: name });
}
export function nonNegativeBigint(name, value) {
    if (value !== undefined && !(typeof value === 'bigint' && value >= 0n))
        refuse({ code: 'invalid-option', object: name });
}
