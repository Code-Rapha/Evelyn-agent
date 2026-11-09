/**
 * A política de aplicação das mudanças do modo DEV (DEV-3).
 *
 * ## O problema
 *
 * "Mude a cor principal do app" e "mude a inicialização do processo" são
 * ambos uma escrita no repositório, mas o que é preciso fazer **depois** é
 * diferente: a primeira pode aparecer na hora, a segunda exige reiniciar. Um
 * agente que trate as duas igual ou promete aplicação instantânea que não
 * aconteceu, ou reinicia a aplicação para trocar um tom de azul.
 *
 * ## A classificação
 *
 * É por **arquivo tocado**, e escolhe a estratégia **mais leve** que basta:
 *
 * | Alcança | Estratégia | Por quê |
 * |---|---|---|
 * | CSS | `hot` | o renderer recarrega e o estilo novo vale |
 * | renderer, HTML, assets | `reload-ui` | só a janela recarrega |
 * | core, adaptadores, web | `restart-app` | o código já carregado não muda |
 * | inicialização, permissões, autorização, DEV, lock de dados | `restart-controlled` | exige verificações extras e recuperação à mão |
 *
 * A regra é conservadora por construção: **um** arquivo crítico na mudança
 * puxa a estratégia para a mais pesada. Não existe "a maioria é CSS, então
 * dá para recarregar".
 */

/** Como a mudança passa a valer. */
export type ApplyStrategy = 'hot' | 'reload-ui' | 'restart-app' | 'restart-controlled';

/** A classificação de um conjunto de arquivos. */
export interface ApplyPlan {
	readonly strategy: ApplyStrategy;
	/** Os arquivos que determinaram a estratégia. */
	readonly decisive: readonly string[];
	/** As verificações extras obrigatórias antes de aplicar. */
	readonly extraChecks: readonly string[];
	/** O que dizer ao proprietário, sem prometer o que não acontece. */
	readonly explanation: string;
}

/**
 * Os caminhos que exigem reinicialização **controlada** (DEV-3).
 *
 * Se mexer aqui, o processo que está rodando não pode simplesmente confiar em
 * si mesmo: a autorização, a trava e a política de permissão vivem no código
 * anterior. Por isso: reinício explícito, checkpoint preservado e o
 * proprietário informado.
 */
const CRITICAL_PATTERNS: readonly RegExp[] = [
	/^src\/desktop\/main\.ts$/i,
	/^src\/core\/agent\/devTools\.ts$/i,
	/^src\/core\/dev\//i,
	/^src\/core\/permissions\//i,
	/^src\/core\/security\//i,
	/^src\/app\/(mount|storageLock|serviceLifecycle)\.ts$/i,
	/^src\/(desktop|web)\/.*(auth|token|panel)/i,
];

/** Os caminhos que só o renderer recarrega. */
const UI_PATTERNS: readonly RegExp[] = [
	/^src\/desktop\/renderer\//i,
	/^src\/web\/assets\//i,
	/\.(html|css|svg|png|ico|woff2?)$/i,
];

/** Os que mudam a cada carregamento sem reinício da janela. */
const HOT_PATTERNS: readonly RegExp[] = [/^src\/desktop\/renderer\/.*\.css$/i];

/** Normaliza o caminho para a comparação (sempre `/`, sem `./`). */
export function normalizeRepoPath(path: string): string {
	return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * As verificações exigidas por cada estratégia (DEV-3).
 *
 * É a **única** fonte: o plano (`applyPolicy`) descreve o que acontece ao
 * aplicativo, e esta tabela diz o que precisa ter rodado antes de "concluído".
 * Duas listas seriam duas verdades — e a operação poderia ficar "verificada"
 * com uma delas em falta.
 */
export const REQUIRED_CHECKS: Readonly<Record<ApplyStrategy, readonly string[]>> = {
	hot: [],
	'reload-ui': ['npm run check-types'],
	'restart-app': ['npm run check-types', 'npm run test:core'],
	'restart-controlled': [
		'npm run check-types',
		'npm run test:core',
		'npm run lint',
		'npm run web:build',
		'npm run desktop:build',
	],
};

/**
 * Classifica a mudança.
 *
 * Sem arquivos não há mudança — e uma lista vazia não pode "passar": ela
 * devolve `restart-controlled`, que é o caminho que exige confirmação.
 */
export function planApply(paths: readonly string[]): ApplyPlan {
	const files = paths.map(normalizeRepoPath).filter((path) => path.length > 0);
	if (files.length === 0) {
		return {
			strategy: 'restart-controlled',
			decisive: [],
			extraChecks: ['nenhum arquivo identificado: confirmar com o proprietário'],
			explanation:
				'não foi possível identificar os arquivos da mudança; nada será aplicado sem confirmação',
		};
	}
	const critical = files.filter((path) => CRITICAL_PATTERNS.some((pattern) => pattern.test(path)));
	if (critical.length > 0) {
		return {
			strategy: 'restart-controlled',
			decisive: critical,
			extraChecks: REQUIRED_CHECKS['restart-controlled'],
			explanation:
				'a mudança alcança inicialização, autorização ou a política de permissões: ' +
				'a aplicação precisa ser reiniciada de forma controlada, com o checkpoint disponível para voltar',
		};
	}
	const core = files.filter((path) => !UI_PATTERNS.some((pattern) => pattern.test(path)));
	if (core.length > 0) {
		return {
			strategy: 'restart-app',
			decisive: core,
			extraChecks: REQUIRED_CHECKS['restart-app'],
			explanation:
				'a mudança alcança código do Core ou do serviço, que já está carregado no processo: ' +
				'o aplicativo precisa ser reiniciado para que ela valha',
		};
	}
	const hot = files.every((path) => HOT_PATTERNS.some((pattern) => pattern.test(path)));
	if (hot) {
		return {
			strategy: 'hot',
			decisive: files,
			extraChecks: REQUIRED_CHECKS.hot,
			explanation: 'é uma mudança de estilo: a janela recarrega a folha e o novo visual vale na hora',
		};
	}
	return {
		strategy: 'reload-ui',
		decisive: files,
		extraChecks: REQUIRED_CHECKS['reload-ui'],
		explanation: 'é uma mudança da interface: só a janela recarrega, sem reiniciar a aplicação',
	};
}

/**
 * A estratégia `wanted` já está coberta por `actual`?
 *
 * A ordem crescente é a ordem de "quanto custa". Aplicar "hot" quando o plano
 * pedia reinício seria mentir; aplicar reinício quando `hot` bastava seria
 * caro, mas seguro. A função diz se `actual` é **suficiente**.
 */
const ORDER: readonly ApplyStrategy[] = ['hot', 'reload-ui', 'restart-app', 'restart-controlled'];

export function coversStrategy(actual: ApplyStrategy, wanted: ApplyStrategy): boolean {
	return ORDER.indexOf(actual) >= ORDER.indexOf(wanted);
}
