/**
 * Cross-layer types.
 *
 * Deliberately dependency-free: every layer may import this module without
 * reaching into another layer just to name a type.
 */

/** Diagnostic sink. The CLI writes to stdout, the ACP transports write to stderr. */
export type Logger = (message: string) => void;
