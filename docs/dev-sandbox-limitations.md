# DEV-AUDIT-02 / DEV-AUDIT-03 — Isolamento real de processos no Windows

**Resultado: bloqueado.** Nenhuma sandbox foi implementada, e nenhum fallback
inseguro foi criado. O `dev_run` continua recusando caminhos fora do
checkout pela linha de comando (DEV-AUDIT-01) e **não** alega isolamento de
processo. Este documento registra o que foi medido, nesta máquina, em
2026-11-05, para que a decisão não precise ser refeita.

> **Retificação (DEV-AUDIT-03).** Uma medição intermediária sugeriu que o
> shell já rodava em AppContainer (`hasAppContainerSid=True`). Era falso:
> o buffer passado a `GetTokenInformation` era curto e o ponteiro lido era
> lixo (`0x8900180A`). Com o tamanho correto:
> `TOKEN_IS_APPCONTAINER=0`, `TOKEN_IS_RESTRICTED=0`, nenhum
> `S-1-15-2-*` nos grupos. **O ambiente não é AppContainer.**


## O que foi testado, e o que cada caminho devolveu

Todos os testes rodaram como o usuário normal `DESKTOP-0VT69HR\rapha`
(UAC desligado, `IsInRole(Administrator) = False`), em Windows 10 19045
(build 19045), Node 24.19.0. Nenhum perfil, ACL ou arquivo de teste
sobreviveu: tudo foi removido ao final.

| Mecanismo | Chamada | Resultado | Interpretação |
|---|---|---|---|
| AppContainer — criar perfil | `CreateAppContainerProfile` | `ERROR_NO_TOKEN` (1008) | **Também com elevação** (ver abaixo) |
| AppContainer — derivar SID | `DeriveAppContainerSidFromAppContainerName` | alterna entre SID válido e erro | Estado inconsistente |
| AppContainer — lançar | `CreateProcessW` + `SECURITY_CAPABILITIES` | **cria o processo** (exit 1, sem ler o próprio script) | A criação funcional *não* basta: sem ACL o checkout fica inacessível |
| Token restrito | `CreateRestrictedToken` com os grupos em deny-only | `ERROR_INVALID_PARAMETER` (87) | Grupo `S-1-5-32-544` não pode ser deny-only |
| Lançar com token restrito | `CreateProcessAsUser`/`CreateProcessWithTokenW` | exige `SeAssignPrimaryToken`/`SeIncreaseQuota`, **ausentes** | Sem esses privilégios não há como lançar com outro token |
| Segunda conta | `LogonUser` | `1326` (logon failure) | Não há conta auxiliar com credencial conhecida |
| Job Object | `CreateJobObject` + `SetInformationJobObject` + `AssignProcessToJobObject` | funciona | Controla contagem de processos e encerramento — **não** ACL |
| Job Object como sandbox | `node` lendo `C:\Windows\win.ini` e escrevendo `C:\Users\Rapha\fora.txt` | **leu e escreveu** | Prova que Job Object sozinho não restringe arquivo (regra explícita do pedido) |

## Por que AppContainer não é uma opção confiável aqui

0. **Medido com elevação real (`TOKEN_ELEVATION=1`): `CreateAppContainerProfile`
   devolve 1008 do mesmo jeito.** Testado com três nomes diferentes, descrições
   curtas, perfil de usuário carregado (`GetUserProfileDirectory` ok) e
   `LocalAppData\Packages` existente. O serviço `AppInfo` está `RUNNING` e o
   `EnableLUA=1`. Ou seja: **não é falta de privilégio** — o subsistema de
   perfil de AppContainer está danificado nesta máquina. Um serviço elevado
   não conserta isso; ele apenas teria o mesmo 1008.
2. **O estado ficou inconsistente depois de remover os perfis de teste.**
   `DeriveAppContainerSidFromAppContainerName` passou a devolver sucesso com
   SID `S-1-15-2-0` (inválido) e a alternar para erro 18. Uma sandbox que
   depende de um registro global reescrevível fora do controle do app não é
   sandbox: é um *pressuposto* sobre a máquina.
3. **Mesmo criando o processo, o Node não conseguia ler o próprio script**
   (`MODULE_NOT_FOUND`) porque `%TEMP%` é negado ao AppContainer por padrão —
   coerente com a teoria, mas mostra que o desenho exige ACL em cada
   diretório auxiliar (checkout, TEMP, cache do npm, `node_modules`,
   `%LOCALAPPDATA%`). Cada concessão é uma linha na superfície de ataque.

## O que a Opção B (serviço C# + AppContainer) provou

A DEV-AUDIT-03 pediu transformar isso num serviço Windows em C#. A
investigação confirmou que **o serviço não resolve a causa**:

- o serviço elevado teria exatamente o mesmo `1008` no `CreateAppContainerProfile`;
- sem perfil, não há SID `S-1-15-2-…`, e sem SID não há token de AppContainer;
- `CreateAppContainerToken` **não existe** em `advapi32` neste build;
- `CreateRestrictedToken` com os grupos em deny-only devolve `ERROR_INVALID_PARAMETER`.

Um serviço que instalasse, autenticasse com HMAC e recebesse pedidos, mas não
conseguisse criar a sandbox, teria de **recusar toda execução** — o que é
exatamente o comportamento correto e já é o que o código faz hoje (o
`DevRunner` não finge isolar). Criar a infraestrutura de serviço sem a
sandbox só aumentaria a superfície: um processo elevado a mais, um pipe a
mais, sem ganho de isolamento.

Dois arquivos de contrato chegaram a ser escritos e **permanecem** porque são
a parte independente do AppContainer:
`src/core/dev/sandboxProtocol.ts` (operação única `run`, validação, tetos) e
`src/core/dev/sandboxAuth.ts` (HMAC-SHA256, janela de tempo, anti-replay).
Eles **não** estão ligados a nada: nenhum código os importa. Ficam como
especificação executável para quando a sandbox for viável — com teste
unitário próprio e sem alegar isolamento.

## O que **não** foi feito, e por quê

- **Não** se implementou `JobObject` como se fosse sandbox. Ele é um bom
  controle de *recursos* (limite de processos, encerramento em cascata) e
  pode entrar numa etapa futura — com o nome certo.
- **Não** se implementou redução de ACL do checkout. Um teste mediu que
  remover a permissão do próprio usuário **não** bloqueia o processo, porque
  o token do DevRunner **é** o do usuário. Sem trocar o token, ACL não isola.
- **Não** se criou fallback "isolamento por validação de caminho" alegando ser
  sandbox. A validação de caminho da DEV-AUDIT-01 é real e continua valendo,
  mas o próprio código diz que não é confinamento.

## Limitação que fica registrada no produto

`DevRunner` executa com o **token do usuário**: um script permitido que
construa um caminho em tempo de execução pode abrir qualquer arquivo do
usuário. A única barreira é a linha de comando
(`assertArgumentsInsideRepository`). Isso está documentado em
`src/core/dev/devRunner.ts`.

## O que faria a sandbox ser viável

1. **Serviço Windows com privilégio**, criando o perfil de AppContainer uma
   vez na instalação e concedendo ACL ao checkout — o install e o serviço
   rodam elevados uma única vez; o DEV em si não.
2. **Conta de serviço dedicada** (`LogonUser` com senha gerenciada por DPAPI)
   e `CreateProcessAsUser` com token restrito — exige decidir onde a senha
   vive.
3. **Sandbox de terceiro** (Windows Sandbox, `wsl --`, container Linux) — muda
   o modelo de distribuição e o requisito de sistema.

Qualquer um dos três é um projeto maior que esta correção, e todos exigem
uma decisão de produto sobre elevação na instalação.
