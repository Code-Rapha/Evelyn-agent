/**
 * Routing mechanisms.
 *
 * The surface is deliberately host-free: classification, the circuit breaker,
 * the streaming engine and a `ChatProvider` that applies them. A host supplies
 * candidates, a policy and a metrics port; this folder supplies the decisions.
 */
export * from './types';
export * from './errors';
export * from './breaker';
export * from './failure';
export * from './engine';
export * from './routedProvider';
export * from './config';
