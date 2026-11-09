# VaultFlow

Ferramenta open-source de backups PostgreSQL e storage para instalação individual. Cada operador hospeda sua própria cópia e utiliza suas próprias credenciais e destinos. Não existe cadastro público, isolamento entre clientes ou um serviço de backups hospedado pelo mantenedor.

## Arquitetura e escopo

- `apps/web`: painel Next.js, NextAuth e Server Actions autenticadas.
- `apps/api`: API Express privada, cron reconciliado e motor de backup em streaming.
- `packages/db`: Prisma/PostgreSQL de metadados e cifragem local das configurações.
- `apps/docs`: página introdutória; as instruções operacionais atuais estão neste README.

```text
Operador → Painel Next.js → PostgreSQL de metadados
                 └─ token interno → API única → Origem → S3 / Drive
```

PostgreSQL gera `.dump` no formato custom; storage gera `.tar.gz`. O conteúdo passa por streams sem spool do backup em disco. A autenticação do `pg_dump` utiliza um arquivo temporário `.pgpass` com permissões restritas, removido ao encerrar o processo.

S3 e serviços compatíveis são o caminho prioritário de validação. Google Drive é **experimental**: depende de configuração/permissões/quota do provedor e ainda requer homologação com credenciais reais. Na origem Drive, use uma pasta específica, sem prefixo; arquivos nativos Google Docs/Sheets/Slides e atalhos são rejeitados, pois exportação ainda não é suportada.

## Requisitos

- Node.js compatível com os manifests (mínimo 22.12; imagem da API usa Node 22) e npm 11.13.0. A versão de Node escolhida também precisa cumprir os requisitos do npm.
- PostgreSQL de metadados exclusivo do VaultFlow.
- Cliente `pg_dump` compatível com a versão do banco de origem, disponível no PATH da API.
- Destino S3 compatível ou Drive configurado e acessível pelo servidor.

A instalação por Docker Compose e o pipeline de CI ainda estão pendentes. O Dockerfile existente constrói somente a API, com contexto na raiz do monorepo. Não publique essa porta diretamente na internet.

## Instalação local

1. Clone o repositório e instale com `npm ci`.
2. Copie `.env.example` para `.env` na raiz e preencha `DATABASE_URL`/`DIRECT_URL` do banco de metadados. Essas URLs não são as origens dos backups.
3. Gere três segredos distintos: segredo de sessão (`NEXTAUTH_SECRET`), token de comunicação interna (`INTERNAL_API_TOKEN`, mínimo 32 caracteres) e chave de cifragem de 32 bytes.

```sh
mkdir -p .secrets
chmod 700 .secrets
openssl rand -hex 32 > .secrets/master.key
chmod 600 .secrets/master.key
openssl rand -base64 32
openssl rand -hex 32
```

As duas últimas saídas são para sessão e token interno; copie os valores para as variáveis correspondentes. Configure `VAULTFLOW_MASTER_KEY_FILE` com o **caminho absoluto** do arquivo `master.key`. Nunca gere uma nova chave para substituir silenciosamente uma perdida: as configurações salvas dependem dela.

4. Defina `ADMIN_USERNAME` e `ADMIN_PASSWORD` explícitos. Não há credenciais padrão. Ajuste `NEXTAUTH_URL` ao endereço usado no navegador e `API_URL` à API interna.
5. O Next.js carrega seu ambiente no workspace web. Crie `apps/web/.env.local` contendo `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `INTERNAL_API_TOKEN`, `API_URL`, `VAULTFLOW_MASTER_KEY_FILE` e, se usado, `ALLOWED_LOCAL_BACKUP_ROOTS` com os mesmos valores da configuração raiz. Arquivos de ambiente reais nunca entram no Git ou na imagem. A API e os scripts do banco já procuram `.env` na raiz.
6. Gere/compile o pacote compartilhado, aplique migrations e crie a conta:

```sh
npm run build -w @vault-flow/db
npm run migrate:deploy -w @vault-flow/db
npm run seed -w @vault-flow/db
npm run dev
```

Painel: `http://localhost:3000`; API: porta 4000; página introdutória: porta 3001. O pacote de banco precisa estar compilado antes do `dev`; recompile após alterar esse pacote. Use banco descartável para desenvolvimento de migrations. Não use `db push` como instalação de produção.

Em base antiga, faça cópia protegida e verifique o histórico antes de aplicar o baseline. Não rode `migrate reset` nem marque uma migration como aplicada sem conferir que os objetos correspondentes já existem. O caminho de atualização de uma base legada deve ser ensaiado numa cópia antes de produção.

## Atualização de credenciais legadas

Instalações anteriores à cifragem possuem `secretVersion=0`. Com a chave correta configurada e a API/painel parados para manutenção:

```sh
npm run migrate:deploy -w @vault-flow/db
npm run migrate:secrets -w @vault-flow/db
```

O migrador é retomável e verifica a cifra em memória antes de gravar. O executor não usa plaintext como fallback. Preserve a chave separadamente da cópia do banco; backups antigos podem conter credenciais abertas e continuam sensíveis. O arquivo de backup da aplicação é compactado, não cifrado pelo VaultFlow.

Reexecutar o seed preserva a senha existente. Para reset local explícito, defina usuário e nova senha no ambiente e execute:

```sh
npm run reset-admin -w @vault-flow/db
```

## Operação

- Uma réplica da API; sem fila distribuída ou retomada de upload pela metade.
- A máquina precisa permanecer ligada. Horários perdidos durante indisponibilidade não são reproduzidos automaticamente.
- Por padrão, uma execução por vez; disparo manual sem capacidade retorna ocupado.
- `BACKUP_TIMEOUT_MS` é o prazo total de preparação, leitura e upload (padrão: 30 minutos). A limpeza tem até 5 segundos adicionais; falhas viram `FAILED`.
- O cron é sincronizado no startup, após alterações do painel e periodicamente (`CRON_RECONCILE_INTERVAL_MS`, padrão: 60000). Falhas transitórias são repetidas sem duplicar tarefas.
- `/health` e disparos retornam indisponibilidade enquanto o scheduler não está pronto. O encerramento solicita cancelamento dos backups; registros interrompidos são recuperados no próximo startup.
- `ALLOWED_LOCAL_BACKUP_ROOTS` habilita origens locais apenas em raízes explícitas, separadas por vírgula. Monte somente os volumes necessários, sem filesystem inteiro, socket Docker ou diretório de segredos.
- Não exponha banco/API; proteja acesso remoto ao painel com rede privada/túnel ou proxy HTTPS. Execute a API sem root e mantenha credenciais de origem/destino com permissões mínimas.

A URI PostgreSQL pode fornecer senha em userinfo ou `?password=...`, que são removidos dos argumentos e transferidos ao `.pgpass`. Parâmetros que sobrescrevem host, arquivos ou comandos são rejeitados; somente opções explicitamente permitidas são repassadas. Configure TLS de acordo com a origem; não desabilite validação para contornar erros.

## Restauração e Supabase

O histórico registra URI do artefato, tamanho e SHA-256. Baixe o arquivo diretamente no destino e confira o hash:

```sh
shasum -a 256 backup.dump
pg_restore --list backup.dump
```

`--list` inspeciona o catálogo, mas não comprova recuperação. Restaure num PostgreSQL **descartável**, com cliente compatível, e confira dados, schema, sequences, constraints e demais objetos do escopo protegido. O destino de teste deve ser definido explicitamente; não restaure sobre produção como verificação.

Para storage, confira o hash, inspecione `tar -tzf backup.tar.gz` e extraia em diretório isolado, verificando nomes, quantidade e conteúdo. As operações de exclusão de projeto não apagam os arquivos externos.

No Supabase, conexão PostgreSQL usa credenciais de banco; uma API key HTTP não substitui essa autenticação. O dump não contém bytes do Storage: arquivos exigem configuração/cópia separada. Não há garantia de snapshot atômico entre banco e storage nem de recuperação integral da plataforma. Homologação de Supabase, uploads reais e restauração completa permanecem critérios de entrega a demonstrar.

## Verificação e contribuição

```sh
npm run lint
npm run check-types
npm test
npm run build
```

Os testes versionados usam `node:test` e simulam falhas de serviços externos. Cobrem cancelamento, timeout, leitura, uploads, cron, argumentos do processo e integridade de arquivo compactado. Não substituem testes reais com S3/Supabase/Drive, restauração de banco ou build da imagem Docker.

Relate falhas com versões, passos e logs sanitizados, sem segredos ou dados de produção.

Licença [MIT](LICENSE). Desenvolvido por [Ariel Lucas](https://github.com/ariellucaslf).
