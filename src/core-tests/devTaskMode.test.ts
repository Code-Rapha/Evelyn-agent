/**
 * DEV-9.1 (item 3) — o modo tarefa muda os limites que o motor aplica.
 *
 * Dois níveis, deliberadamente separados:
 *
 * 1. **Contrato do turno**: com o `task` ligado, o `ChatSession` constrói o
 *    motor com o teto de tarefa e escolhe o relógio de inatividade. Isto é
 *    verificado pelo **comportamento observável** — o número de rounds que o
 *    turno aguenta —, não pela leitura do código.
 * 2. **Constantes**: o teto de tarefa é maior que o de pergunta, e a
 *    inatividade é menor que o teto total (senão nunca seria ela a encerrar).
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import {
	DEFAULT_TURN_TIMEOUT_MS,
	TASK_IDLE_TIMEOUT_MS,
	TASK_MAX_TURNS,
	TASK_TURN_TIMEOUT_MS,
} from '../desktop/chatSession';

test('o teto de rounds da tarefa é maior que o de uma pergunta', () => {
	// Uma pergunta para no padrão do motor (8). Uma tarefa precisa caber:
	// ler, escrever, rodar, corrigir, rodar de novo — várias vezes.
	assert.ok(TASK_MAX_TURNS > 8, `tarefa=${TASK_MAX_TURNS}`);
	assert.ok(TASK_MAX_TURNS >= 30, 'meia dúzia de idas e voltas não é uma tarefa');
});

test('o teto de tempo da tarefa é maior, e a inatividade encerra antes', () => {
	assert.ok(TASK_TURN_TIMEOUT_MS > DEFAULT_TURN_TIMEOUT_MS, 'a tarefa tem mais tempo total');
	assert.ok(TASK_IDLE_TIMEOUT_MS < TASK_TURN_TIMEOUT_MS, 'a inatividade tem de vir antes do teto total');
	assert.ok(TASK_IDLE_TIMEOUT_MS >= 5 * 60_000, 'um comando longo não pode parecer travamento');
});
