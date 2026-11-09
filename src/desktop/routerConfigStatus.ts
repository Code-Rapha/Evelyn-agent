/**
 * O estado observado da configuração do roteador.
 *
 * ## Por que existe
 *
 * Ler o roteador tem quatro desfechos, e três deles se parecem com "nativo"
 * quando só a configuração é olhada:
 *
 * - **normal**: o arquivo existe e foi lido;
 * - **recovered**: o arquivo sumiu ou não era válido, e a cópia de segurança
 *   devolveu a última escolha boa;
 * - **unreadable**: o arquivo existe e não pode ser lido, e não há cópia —
 *   o turno está usando o **padrão**, que não é uma escolha;
 * - **unset**: nunca houve escolha.
 *
 * `configured` responde "houve escolha?" e não distingue os outros três. Aqui
 * essa distinção é um valor único, derivado do que o Core já devolve — não de
 * uma segunda leitura do disco.
 */

/** A configuração, como o Core a entrega, mais a origem. */
export interface RouterConfigView {
	readonly mode: 'native' | 'external' | 'direct';
	readonly enabled: boolean;
	/** O provedor que age como roteador externo, quando o modo é `external`. */
	readonly externalRouterProviderId?: string;
	/** O provedor chamado diretamente, quando o modo é `direct`. */
	readonly directProviderId?: string;
	readonly updatedAt: string;
	readonly configured: boolean;
	/**
	 * O arquivo do roteador existe e não pode ser lido.
	 *
	 * Ausente = não há problema. Presente = a página diz que há uma
	 * configuração que não pode ser lida, em vez de "nunca configurado".
	 */
	readonly unreadable?: string;
	/**
	 * A configuração veio da cópia de segurança, e não do arquivo principal.
	 *
	 * Só é verdadeiro quando a leitura usou a cópia **validada**; a página diz
	 * isso, porque uma escolha recuperada é uma escolha que precisa de atenção.
	 */
	readonly recoveredFromBackup?: boolean;
}

/**
 * O estado para a interface.
 *
 * Derivado do `RouterConfigView` e de nada mais:
 *
 * - `unreadable` presente → `unreadable` (o pior estado: há arquivo, não há
 *   leitura, e o que vale é o padrão);
 * - `recoveredFromBackup` → `recovered`;
 * - `configured` → `normal`;
 * - sem nada → `unset`.
 */
export type RouterConfigStatus = 'normal' | 'recovered' | 'unreadable' | 'unset';

/** O estado da configuração, a partir do que o Core devolveu. */
export function routerConfigStatus(view: RouterConfigView): RouterConfigStatus {
	if (view.unreadable !== undefined) {
		return 'unreadable';
	}
	if (view.recoveredFromBackup === true) {
		return 'recovered';
	}
	return view.configured ? 'normal' : 'unset';
}

/**
 * A configuração pode ser gravada por cima?
 *
 * No estado `unreadable` **não**: o formulário está preenchido com o padrão, e
 * salvar por cima jogaria fora a única coisa que ainda poderia ser recuperada.
 * Salvar daqui só depois de reparar o arquivo.
 */
export function canSaveRouterConfig(status: RouterConfigStatus): boolean {
	return status !== 'unreadable';
}
