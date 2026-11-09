/**
 * Processo auxiliar dos testes de trava (DEV-2.2).
 *
 * Segura a trava da raiz pelo tempo pedido e imprime o resultado. Existe como
 * arquivo porque os testes precisam de um **segundo processo de verdade** —
 * um mock no mesmo processo não prova exclusão mútua.
 *
 * Uso: node devLockHelper.js <raiz> <segurarMs> [--fail]
 *
 * Saída: uma linha com o desfecho (`acquired:<pid>` / `busy:<motivo>` /
 * `failed:<motivo>`), e `released` quando soltou.
 */
const { join } = require('node:path');

const outDir = join(__dirname, '..', '..');
const { acquireDevLock } = require(join(outDir, 'core', 'dev', 'devFileLock.js'));

const [root, holdText, ...flags] = process.argv.slice(2);
const holdMs = Number(holdText ?? '0');
const shouldFail = flags.includes('--fail');

(async () => {
	const result = await acquireDevLock(root, { waitMs: holdMs > 0 ? 0 : 0 });
	if (result.kind !== 'acquired') {
		process.stdout.write(`${result.kind}:${result.reason ?? result.message ?? ''}\n`);
		process.exit(0);
	}
	process.stdout.write(`acquired:${process.pid}\n`);
	if (shouldFail) {
		// Saída de erro **sem** liberar: simula a exceção que esquece o finally.
		process.exitCode = 1;
		return;
	}
	if (holdMs > 0) {
		await new Promise((resolve) => setTimeout(resolve, holdMs));
	}
	await result.lock.release();
	process.stdout.write('released\n');
	process.exit(0);
})().catch((error) => {
	process.stdout.write(`threw:${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
