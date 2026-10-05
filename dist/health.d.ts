export interface HealthResult {
    ok: boolean;
    latencyMs: number;
    /** Present only when `ok` is false; scrubbed of the connection password. */
    error?: string;
}
