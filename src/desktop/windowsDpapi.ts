/**
 * A criptografia local do Windows (DEV-7): DPAPI via PowerShell.
 *
 * ## Por que por processo
 *
 * O mocha roda em `node.exe`, que não tem as APIs nativas do Electron; o app
 * roda no `electron.exe`. Chamar o `System.Security.Cryptography.ProtectedData`
 * pelo PowerShell funciona nos dois e não adiciona dependência nativa.
 *
 * ## O que o DPAPI protege aqui, e o que não
 *
 * `Protect(..., 'CurrentUser')` cifra um blob de modo que **só o usuário do
 * Windows que cifrou** consegue decifrar na máquina. Isso protege o arquivo em
 * repouso: copiar o arquivo para outro computador ou para outra conta não
 * revela nada, e ler o disco sem a conta não revela a chave.
 *
 * **Não** prova identidade: qualquer processo rodando como o **mesmo** usuário
 * pode pedir ao DPAPI que decifre o mesmo blob. Nada neste módulo é capaz de
 * distinguir "o proprietário digitou a senha" de "outro processo do mesmo
 * usuário copiou a chave cifrada". O módulo é uma **fechadura de arquivo**, não
 * um autenticador.
 *
 * ## Falha segura
 *
 * Blob ilegível, DPAPI indisponível, saída inesperada: tudo é `undefined`
 * (ou uma recusa), nunca um "abriu". Quem chama decide o que "não sei" faz —
 * e neste app "não sei" não autoriza.
 */

import { execFile } from 'node:child_process';

/** O resultado de pedir ao DPAPI. */
export type SealedResult =
	| { readonly kind: 'sealed'; readonly base64: string }
	| { readonly kind: 'unavailable'; readonly reason: string };

/** O resultado de pedir a abertura. */
export type UnsealedResult =
	| { readonly kind: 'opened'; readonly base64: string }
	| { readonly kind: 'unavailable'; readonly reason: string }
	| { readonly kind: 'corrupt'; readonly reason: string };

/** Como o PowerShell é executado (injetável: a suíte não depende dele). */
export type PowerShellRunner = (script: string) => Promise<{ readonly ok: boolean; readonly stdout: string; readonly stderr: string }>;

/** O executor real: `powershell -NoProfile -NonInteractive`, com prazo. */
export const runPowerShell: PowerShellRunner = (script) =>
	new Promise((resolve) => {
		execFile(
			'powershell',
			['-NoProfile', '-NonInteractive', '-Command', script],
			{ timeout: 20_000, windowsHide: true, maxBuffer: 64 * 1024 },
			(error, stdout, stderr) => {
				resolve({ ok: error === null, stdout, stderr });
			},
		);
	});

/** O prelúdio: carrega a montagem de criptografia do .NET. Ajustado uma vez por chamada. */
const PRELUDE = 'Add-Type -AssemblyName System.Security; ';

/** O DPAPI está disponível nesta máquina? (checagem de plataforma + reação) */
export function dpapiAvailable(platform: NodeJS.Platform = process.platform): boolean {
	return platform === 'win32';
}

/**
 * Cifra bytes para o usuário atual.
 *
 * Devolve base64, nunca o blob: o chamador grava em um arquivo só seu.
 */
export async function sealForCurrentUser(
	plain: Buffer,
	options: { readonly run?: PowerShellRunner; readonly platform?: NodeJS.Platform } = {},
): Promise<SealedResult> {
	if (!dpapiAvailable(options.platform ?? process.platform)) {
		return { kind: 'unavailable', reason: 'o DPAPI só existe no Windows' };
	}
	const run = options.run ?? runPowerShell;
	const script =
		PRELUDE +
		`$b=[Convert]::FromBase64String('${plain.toString('base64')}'); ` +
		`$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); ` +
		'[Convert]::ToBase64String($p)';
	const result = await run(script);
	if (!result.ok) {
		// A saída do erro **não** é repassada: ela pode conter o comando com
		// bytes do segredo.
		return { kind: 'unavailable', reason: 'o DPAPI não cifrou' };
	}
	const base64 = result.stdout.trim();
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length === 0) {
		return { kind: 'unavailable', reason: 'o DPAPI devolveu algo que não é base64' };
	}
	return { kind: 'sealed', base64 };
}

/**
 * Abre bytes cifrados para o usuário atual.
 *
 * `corrupt` quando o blob não é base64 ou o DPAPI o recusa: o arquivo foi
 * adulterado, truncado ou veio de outro usuário.
 */
export async function unsealForCurrentUser(
	sealedBase64: string,
	options: { readonly run?: PowerShellRunner; readonly platform?: NodeJS.Platform } = {},
): Promise<UnsealedResult> {
	if (!dpapiAvailable(options.platform ?? process.platform)) {
		return { kind: 'unavailable', reason: 'o DPAPI só existe no Windows' };
	}
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sealedBase64) || sealedBase64.length === 0) {
		return { kind: 'corrupt', reason: 'o arquivo protegido não está em base64' };
	}
	const run = options.run ?? runPowerShell;
	const script =
		PRELUDE +
		`$p=[Convert]::FromBase64String('${sealedBase64}'); ` +
		`[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($p,$null,'CurrentUser'))`;
	const result = await run(script);
	if (!result.ok) {
		return { kind: 'corrupt', reason: 'o DPAPI não conseguiu abrir o arquivo protegido' };
	}
	const base64 = result.stdout.trim();
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
		return { kind: 'corrupt', reason: 'o DPAPI devolveu algo que não é base64' };
	}
	return { kind: 'opened', base64 };
}

/**
 * O nome do usuário do Windows deste processo.
 *
 * Vem do ambiente **do processo**, não do renderer. Ausente é `undefined`, e a
 * autorização inteira fica indisponível (não há "usuário desconhecido" que
 * valha).
 */
export function currentWindowsUser(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const name = env['USERNAME'];
	return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined;
}

/**
 * O que o DPAPI garante, em texto para o relatório e para a interface.
 *
 * Fica no código para não haver duas versões da mesma promessa.
 */
export const DPAPI_SCOPE = {
	protects: [
		'arquivo em repouso: copiado para outro computador, não abre',
		'outra conta do Windows na mesma máquina, não abre',
		'exigir a senha de novo em cada ativação (fora do processo principal)',
	],
	doesNotProtect: [
		'outro processo rodando como o MESMO usuário do Windows: pode pedir ao DPAPI que abra o mesmo blob',
		'administrador local ou comprometimento completo da máquina',
		'que o clique tenha vindo de um humano e não de automação na mesma conta',
	],
} as const;
