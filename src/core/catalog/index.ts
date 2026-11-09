/**
 * Fusão do catálogo com a descoberta, e a política de acesso.
 *
 * Quatro módulos puros, sem I/O:
 *
 * - `merge` compara o preço declarado com o publicado e diz qual vale, sem
 *   trocar de lado sozinho;
 * - `metadata` funde limites e capacidades, campo por campo, com conflito
 *   explícito;
 * - `policy` decide o que pode ser chamado sob `any`/`free_only`/`free_preferred`
 *   e reconhece a frase que liga `free_only`.
 */
export * from './merge';
export * from './metadata';
export * from './policy';
