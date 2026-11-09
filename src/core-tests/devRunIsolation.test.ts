/**
 * Isolamento de caminho no `dev_run` (DEV-AUDIT-01).
 *
 * A allowlist decide **qual binário** roda; ela não impede que o argumento
 * aponte para fora do repositório. `node ler.js C:\Users\…\owner-credential.json`
 * era aceito e lido pela auditoria. Estas regras fecham a passagem do caminho
 * pela **linha de comando**, sem tirar do DEV testes, `npm` e builds.
 *
 * Limitação explícita: um script permitido ainda pode montar um caminho em
 * tempo de execução e abrir. Isto não é sandbox de sistema operacional —
 * para isso seria preciso confinamento do processo (Job Object/AppContainer),
 * que não existe aqui.
 */
import * as assert from 'node:assert/strict';
import { test } from 'node:test';

import { assertArgumentsInsideRepository, DevCommandRefusedError, validateDevCommand } from '../core/dev/devRunner';

const ROOT = 'C:\\repo';

test('caminho absoluto Windows é recusado', () => {
	for (const arg of ['C:\\Users\\Rapha\\segredo.json', 'D:/fora/x.txt', '\\\\servidor\\share\\x']) {
		assert.throws(() => assertArgumentsInsideRepository(['node', 'ler.js', arg], ROOT), DevCommandRefusedError, arg);
	}
});

test('caminho absoluto POSIX é recusado', () => {
	for (const arg of ['/etc/passwd', '/home/x/.ssh/id_rsa']) {
		assert.throws(() => assertArgumentsInsideRepository(['node', 'ler.js', arg], '/repo'), DevCommandRefusedError, arg);
	}
});

test('`..` que sobe acima da raiz é recusado', () => {
	for (const arg of ['../../fora.txt', 'src/../../../fora.txt', '..\\..\\fora.txt']) {
		assert.throws(() => assertArgumentsInsideRepository(['node', 'ler.js', arg], ROOT), DevCommandRefusedError, arg);
	}
});

test('URL com esquema é recusada; `file:` para dentro é aceita', () => {
	assert.throws(() => assertArgumentsInsideRepository(['node', 'ler.js', 'file:///C:/Windows/win.ini'], ROOT), DevCommandRefusedError);
	assert.throws(() => assertArgumentsInsideRepository(['node', 'ler.js', 'https://example.com/x'], ROOT), DevCommandRefusedError);
	assert.doesNotThrow(() =>
		assertArgumentsInsideRepository(['node', 'ler.js', 'file:///C:/repo/src/a.txt'], ROOT),
	);
});

test('caminho relativo e flags continuam aceitos', () => {
	for (const arg of ['src/a.ts', 'package.json', '--noEmit', '-p', 'tsconfig.json', '.']) {
		assert.doesNotThrow(() => assertArgumentsInsideRepository(['node', 'x.js', arg], ROOT), arg);
	}
});

test('comandos do DEV que precisam funcionar continuam válidos', () => {
	// Sem argumento parecido com caminho: nada a julgar.
	for (const command of ['npm run test', 'npm run check-types', 'npm test', 'git status', 'git diff', 'eslint']) {
		const argv = validateDevCommand(command);
		assert.doesNotThrow(() => assertArgumentsInsideRepository(argv, ROOT), command);
	}
	// Com caminho: o relativo continua aceito (`node <script>`).
	const nodeScript = validateDevCommand('node slow.js');
	assert.doesNotThrow(() => assertArgumentsInsideRepository(nodeScript, ROOT));
	assert.doesNotThrow(() => assertArgumentsInsideRepository(validateDevCommand('git diff'), ROOT));
});

test('o comando que a auditoria usou para ler a credencial é recusado', () => {
	const argv = validateDevCommand('node ler.js C:\\Users\\Rapha\\.modelhub\\seshyina\\dev\\owner-credential.json');
	assert.throws(
		() => assertArgumentsInsideRepository(argv, ROOT),
		(error: unknown) => {
			assert.ok(error instanceof DevCommandRefusedError);
			assert.match(error.message, /caminho absoluto/);
			return true;
		},
	);
});

test('o comando que a auditoria usou para escrever fora é recusado', () => {
	const argv = validateDevCommand('node escrever.js ../../../fora.txt');
	assert.throws(() => assertArgumentsInsideRepository(argv, ROOT), DevCommandRefusedError);
});
