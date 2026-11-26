/** Maximum active wall time allowed for one durable operation (72 hours). */
export const MAX_OPERATION_ACTIVE_MS = 4_320 * 60_000;
/** Maximum inference submissions one durable operation may authorize. */
export const MAX_OPERATION_INFERENCE_SUBMISSIONS = 10_000;
/** Default inference submission ceiling across all durable units in one operation. */
export const DEFAULT_OPERATION_INFERENCE_SUBMISSIONS = 1_000;
