/**
 * Limites de consumo: agregação do período, a decisão de gastar e a porta de
 * persistência.
 *
 * Este bloco é puro e não conhece host, disco, transporte ou relógio. O host
 * entrega o consumo que o ledger já gravou e recebe uma decisão; o
 * armazenamento entrega e guarda os limites; o roteador consulta a decisão
 * antes de chamar um modelo pago.
 */
export * from './aggregate';
export * from './policy';
export * from './limitsPort';
export * from './forecast';
export * from './alerts';
export * from './turns';
