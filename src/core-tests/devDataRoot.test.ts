/**
 * DEV-8.2: a raiz de dados vinda da linha de comando.
 *
 * ## O defeito que estes testes prendem
 *
 * O app empacotado recebia `--root=C:\X` (o Windows empacota o par em um
 * argumento só) e `rootArgument()` **ignorava**, caindo na raiz padrão sem
 * avisar — medido: `rootOverride=undefined` com o argv contendo o valor. O
 * teste de isolamento do app real foi interrompido antes de ativar o DEV.
 *
 * Aqui a leitura é pura: nenhum arquivo é aberto. O que se prova é a
 * **interpretação** do argumento, não o que o app faz com ele (isso é o
 * teste do pacote, `dev82Isolation`).
 */
import * as assert from 'node:assert/strict';

/**
 * A função é privada no `main.ts` (ele carrega Electron no topo, e importá-lo
 * num teste puro abriria o runtime). A cópia abaixo é comparada com a
 * implementação real pelo teste de contrato do pacote; aqui ela fica como
 * especificação executável da regra.
 */
function rootArgumentFor(argv: readonly string[]): string | undefined {
	const args = [...argv];
	const index = args.indexOf('--root');
	if (index >= 0) {
		const value = args[index + 1];
		if (value !== undefined && !value.startsWith('--')) {
			return value;
		}
	}
	const inline = args.find((arg) => arg.startsWith('--root='));
	if (inline !== undefined) {
		const value = inline.slice('--root='.length).trim();
		return value.length > 0 ? value : undefined;
	}
	return undefined;
}

suite('DEV-8.2: leitura de --root', () => {
	test('aceita a forma em par', () => {
		assert.equal(rootArgumentFor(['main.js', '--root', 'C:\\dados']), 'C:\\dados');
	});

	test('aceita a forma igual (a que o empacotador produz)', () => {
		assert.equal(rootArgumentFor(['--root=C:\\dados']), 'C:\\dados');
		assert.equal(rootArgumentFor(['--root=/home/u/dados']), '/home/u/dados');
	});

	test('a forma igual vence a ausência do par, e não confunde flags', () => {
		assert.equal(rootArgumentFor(['--inspect', '--root=C:\\a']), 'C:\\a');
		assert.equal(rootArgumentFor(['--root', '--probe=x']), undefined);
		assert.equal(rootArgumentFor(['--root=']), undefined);
	});

	test('sem argumento, não há raiz (o app usa a padrão)', () => {
		assert.equal(rootArgumentFor([]), undefined);
		assert.equal(rootArgumentFor(['--probe=x']), undefined);
	});
});
