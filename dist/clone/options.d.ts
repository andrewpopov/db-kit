/** A numeric option that is not what it must be is refused by name, before anything is read or written: `fetchRows: 0` would make every verification compare empty to empty. */
export declare function positiveInteger(name: string, value: number | undefined): void;
/** Finite and not negative (a duration that may be fractional or zero). */
export declare function nonNegativeNumber(name: string, value: number | undefined): void;
export declare function nonNegativeBigint(name: string, value: bigint | undefined): void;
