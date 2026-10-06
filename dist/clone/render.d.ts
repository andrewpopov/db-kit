import type { ClonePlan } from './plan.js';
/** The plan as JSON. 64-bit values (sequence bounds, restart values) are strings: JSON numbers cannot carry them. */
export declare function planToJson(plan: ClonePlan): string;
export declare function planToText(plan: ClonePlan): string;
