# Plano de Implementação: Backup de Storage & Evolução do Sistema (VaultFlow)

Este documento apresenta a análise arquitetural completa do projeto **DumpFlow**, a sugestão de novo nome para expandir o escopo da plataforma, e o plano de implementação detalhado para a funcionalidade de **Backup de Storage para Storage / Nuvem** com o mesmo rigor, controle, agendamento e histórico já existentes para o PostgreSQL.

---

## 1. Análise Geral e Padrões do Projeto

### Arquitetura Atual
- **Monorepo**: Gerenciado via **Turborepo** com `npm workspaces`:
  - `apps/api`: Servidor Express em TypeScript com orquestrador de backups e agendador `node-cron`.
  - `apps/web`: Painel Next.js (App Router) com Tailwind CSS v4, Lucide Icons e autenticação NextAuth via banco de dados.
  - `apps/docs`: Aplicação de documentação.
  - `packages/db`: Prisma ORM centralizado conectado ao PostgreSQL.
  - `packages/ui`, `packages/typescript-config`, `packages/eslint-config`.
- **Padrões de Engenharia (`.agents/AGENTS.md`)**:
  - **MVC**: Prisma no Model/Repository, Next.js na View, Controllers dedicados com tipagem estrita na API.
  - **Rotas Centralizadas**: Cada domínio possui seu controller e arquivo de rotas (ex: `project.controller.ts`, `project.routes.ts`) agregados em `apps/api/src/routes/index.ts`.
  - **Streaming First**: O backup de banco nunca toca o disco (`pg_dump` é canalizado via `PassThrough` diretamente para upload S3 Multipart ou Google Drive). O mesmo princípio de **alta performance com baixíssimo consumo de RAM/Disco** deve ser preservado para o backup de storage.
  - **Envelope de Resposta Padrão**: `{ "success": true, "data": ..., "error": null }`.
  - **Validação Defensiva**: Validação de schema com Zod em todas as fronteiras (API e Server Actions).

---

## 2. Novo Nome Aprovado: VaultFlow (`vault-flow`)

O novo nome **VaultFlow** foi aprovado para refletir com fidelidade a expansão de escopo do sistema de mero orquestrador de dumps para uma plataforma unificada de **Backup, Disaster Recovery e Proteção Contínua de Dados (Bancos e Storages)**.

### Atualização do Repositório Remoto no Git:
Como o repositório no GitHub já foi renomeado, execute o seguinte comando no terminal para atualizar a URL do remote local:

- **Via SSH (Recomendado, padrão atual do repositório)**:
  ```bash
  git remote set-url origin git@github.com:ariellucaslf/vault-flow.git
  ```

- **Via HTTPS (Alternativa)**:
  ```bash
  git remote set-url origin https://github.com/ariellucaslf/vault-flow.git
  ```

Para verificar se a alteração foi aplicada:
```bash
git remote -v
```

---

## 2.1. Estrutura de Branches no Padrão Conventional Commits

Para mantermos o fluxo de desenvolvimento limpo, rastreável e aderente às melhores práticas de Git Flow e Conventional Commits, cada etapa possui sua branch e convenção de commits:

| Etapa | Branch Sugerida | Tipo / Escopo | Exemplos de Conventional Commits |
|---|---|---|---|
| **1. Rebranding** | `chore/rebrand-vaultflow` | `chore` / `docs` | `chore(repo): update branding, package names and metadata to vaultflow`<br>`docs: update README and guides for vaultflow` |
| **2. Modelagem DB** | `feat/db-storage-backup-schema` | `feat(db)` | `feat(db): add storage source entity and project type to prisma schema`<br>`feat(db): add migration for storage backup support` |
| **3. Motor de Backup** | `feat/api-storage-backup-engine` | `feat(api)` | `feat(api): implement s3 and gdrive storage providers`<br>`feat(api): add streaming tar archive service for storage snapshots`<br>`feat(api): connect storage backup to orchestrator and scheduler` |
| **4. Interface Next.js** | `feat/web-storage-backup-ui` | `feat(web)` | `feat(web): add storage provider selection to new project form`<br>`feat(web): update project list table and dashboard metrics`<br>`feat(web): support bigint file size formatting and file counts in logs` |
| **5. Testes & Validação** | `test/storage-backup-verification` | `test` / `ci` | `test(api): add unit and integration checks for storage streaming`<br>`test(types): ensure 100% strict type-check compliance across monorepo` |

> *Nota*: Caso prefira desenvolver a feature completa em uma única branch de integração antes do merge na `main`, a branch padrão recomendada é:
> ```bash
> feat/storage-backup-engine
> ```

---

## 3. Arquitetura da Feature: Backup de Storage

### Como Funciona o Backup de Storage
Diferente de um banco de dados relacional que gera um arquivo `.dump` único via processo CLI, um storage é composto por múltiplos objetos/arquivos, metadados e hierarquias de prefixos/pastas.

Para fornecer o **mesmo controle e integridade do PostgreSQL**, adotaremos a estratégia padrão da indústria (similar a ferramentas enterprise de Disaster Recovery):

1. **Estratégia de Snapshot Compactado via Streaming (Padrão Otimizado)**:
   - Os arquivos do Storage de Origem (AWS S3, MinIO, Cloudflare R2, Google Drive ou Diretório Local) são listados iterativamente (paginação com baixo consumo de memória).
   - Um pipeline de streaming compacta os objetos em tempo real em formato `.tar.gz` (usando streaming sem gravação intermediária em disco local).
   - O stream resultante é transmitido em tempo real para os destinos configurados (S3/MinIO via Multipart Upload ou Google Drive).
   - **Vantagens**:
     - Produz um artefato de backup com data e hora exatas (`backup-storage-<nome>-<timestamp>.tar.gz`).
     - Não sobrescreve arquivos seletivamente e permite recuperação pontual no tempo (Point-in-Time Recovery).
     - Métricas precisas de tamanho (`fileSize`) e quantidade de arquivos (`fileCount`) gravadas diretamente no `BackupLog`.
     - Funciona de forma 100% equivalente ao dump de banco de dados no painel.

2. **Provedores de Origem e Destino Suportados**:
   - **S3 & S3-Compatible**: AWS S3, MinIO, Cloudflare R2, Wasabi, Supabase Storage (suporte a `endpoint` customizado).
   - **Google Drive**: Pastas corporativas ou pessoais via Service Account.
   - **Local Storage / Server Path**: Diretórios montados no servidor (ex: `/app/storage`, volumes Docker).

---

## 4. Mudanças Propostas

### 4.1. Camada de Dados (`packages/db`)

#### [MODIFY] [schema.prisma](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/packages/db/prisma/schema.prisma)
- Atualizar o modelo `Project`:
  - Adicionar campo `type`: `"DATABASE" | "STORAGE"` (default `"DATABASE"` para garantir compatibilidade retroativa total com dados existentes).
  - Tornar `dbUrl` opcional (`String?`).
  - Adicionar relação opcional `storageSource StorageSource?`.
- Criar modelo `StorageSource`:
  - `id`: UUID.
  - `type`: `"AWS_S3" | "S3_COMPATIBLE" | "GOOGLE_DRIVE" | "LOCAL_PATH"`.
  - `credentials`: JSON string (chaves de acesso, secret, endpoint para MinIO, region, etc.).
  - `targetFolder`: Nome do bucket, ID da pasta ou caminho do diretório de origem.
  - `prefix`: Prefixo ou subpasta opcional a ser incluída no backup.
  - `projectId`: Foreign key única para `Project`.
- Atualizar modelo `BackupLog`:
  - Alterar `fileSize` para `BigInt?` (para suportar storages de dezenas/centenas de GBs sem risco de overflow no PostgreSQL).
  - Adicionar `fileCount`: `Int?` (número total de arquivos processados no snapshot).
- Criar e rodar migração Prisma com nome descritivo:
  ```bash
  npx prisma migrate dev --name add_storage_backup_support
  ```

---

### 4.2. Camada de Backend & Motor de Backup (`apps/api`)

#### [NEW] [storageProvider.interface.ts](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/api/src/services/providers/storageProvider.interface.ts)
- Definir interface desacoplada `IStorageProvider`:
  - `listFiles(prefix?: string): AsyncIterable<StorageFileItem>`
  - `getFileStream(key: string): Promise<Readable>`
  - `putFileStream(key: string, stream: Readable): Promise<UploadResult>`

#### [NEW] [s3Provider.ts](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/api/src/services/providers/s3Provider.ts)
- Implementar provedor S3 genérico compatível com AWS S3, MinIO, Cloudflare R2 e Wasabi (aceita `endpoint`, `region`, `credentials`, `bucket`).
- Suporte a listagem paginada (`ListObjectsV2Command` com `ContinuationToken`).
- Download em streaming com `GetObjectCommand`.

#### [NEW] [googleDriveProvider.ts](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/api/src/services/providers/googleDriveProvider.ts)
- Implementar provedor Google Drive via Service Account.
- Listagem recursiva de arquivos dentro do `folderId` informado.
- Obtenção do stream binário de cada arquivo.

#### [NEW] [storageBackupService.ts](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/api/src/services/storageBackupService.ts)
- Orquestrador de arquivamento em streaming:
  - Inicializa um stream de compressão `tar.gz` (usando `archiver` ou pipeline nativo com `zlib.createGzip`).
  - Itera sobre os arquivos da origem e os empacota sob demanda.
  - Monitora bytes totais e quantidade de arquivos em tempo real.
  - Retorna o stream resultante e uma promessa de contagem/tamanho final.

#### [MODIFY] [backupOrchestrator.ts](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/api/src/services/backupOrchestrator.ts)
- Atualizar a função principal `runBackupForProject(projectId: string)`:
  - Carregar projeto incluindo `destinations` e `storageSource`.
  - Se `project.type === 'DATABASE'`: executa o fluxo existente `executePgDump(project.dbUrl)`.
  - Se `project.type === 'STORAGE'`: instancia o `storageBackupService` baseado no `storageSource`.
  - Canaliza o stream gerado para todos os destinos configurados (`uploadToS3` ou `uploadToGoogleDrive`).
  - Atualiza o `BackupLog` com status `SUCCESS` ou `FAILED`, salvando `fileSize` e `fileCount`.

#### [MODIFY] [cronManager.ts](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/api/src/scheduler/cronManager.ts)
- Assegurar agendamento transparente de projetos do tipo `DATABASE` e `STORAGE`.
- Mensagens de log indicando o tipo de projeto agendado.

#### [MODIFY] [project.controller.ts](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/api/src/controllers/project.controller.ts)
- `listProjects`: incluir `storageSource` no retorno da consulta Prisma.
- Adicionar validações defensivas e envelopes padrão `{ success, data, error }`.

---

### 4.3. Camada de Frontend & Painel de Controle (`apps/web`)

#### [MODIFY] [project.actions.ts](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/web/app/actions/project.actions.ts)
- Atualizar schema Zod (`projectSchema`):
  - Suportar validação condicional: se `type === 'DATABASE'`, valida `dbUrl`; se `type === 'STORAGE'`, valida provedor de origem, bucket/pasta e credenciais da origem.
  - Criação transacional do `Project` e respectivo `StorageSource` via Prisma.

#### [MODIFY] [projects/new/page.tsx](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/web/app/(dashboard)/projects/new/page.tsx)
- Adicionar seletor de Tipo de Projeto:
  - 🗄️ **Banco de Dados (PostgreSQL)**
  - 📦 **Armazenamento / Storage (S3, MinIO, R2, Google Drive)**
- Exibição dinâmica dos campos de origem:
  - Ao selecionar Storage: seleção do Provedor de Origem (AWS S3, MinIO / S3 Compatível, Google Drive), Bucket/Pasta de Origem, Endpoint customizado (opcional para MinIO), Prefixo opcional e Credenciais JSON.
- Configuração de agendamento Cron (mantendo a tradução em português em tempo real).
- Configuração de Destinos (onde salvar a cópia do storage).

#### [MODIFY] [projects/page.tsx](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/web/app/(dashboard)/projects/page.tsx)
- Adicionar badges visuais diferenciando projetos de **Banco** e **Storage**:
  - Ícone de Banco (Azul) para PostgreSQL.
  - Ícone de Caixa/Nuvem/HardDrive (Púrpura/Ciano) para Storage.
- Exibir resumo da Origem e Destino com clareza.
- Botão de execução manual imediata funcionando para ambos os tipos.

#### [MODIFY] [logs/page.tsx](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/web/app/(dashboard)/logs/page.tsx)
- Formatação adequada de tamanho de arquivo com suporte a valores `BigInt` (bytes -> KB -> MB -> GB).
- Exibição de contagem de arquivos para backups de storage quando disponível.
- Identificação visual do tipo de recurso cujo backup foi executado.

#### [MODIFY] [layout.tsx](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/web/app/(dashboard)/layout.tsx) & [page.tsx](file:///Volumes/Ugreen%20HD/ALP/VaultFlow/apps/web/app/(dashboard)/page.tsx)
- Atualização da identidade visual para o novo nome (**VaultFlow**).
- Dashboard de métricas atualizado: contadores separados de Bancos Protegidos e Storages Protegidos.

---

## 5. Plano de Verificação

### 5.1. Verificação Automatizada
- Executar typecheck em todo o monorepo:
  ```bash
  npm run check-types
  ```
- Executar linter em todos os workspaces:
  ```bash
  npm run lint
  ```
- Executar build de produção para validar pacotes:
  ```bash
  npm run build
  ```

### 5.2. Verificação Manual / Funcional
- **Criação de Projeto de Storage**:
  - Acessar `http://localhost:3000/projects/new`.
  - Criar um projeto selecionando **Storage** com origem S3/MinIO ou Google Drive e destino configurado.
  - Validar persistência no banco e aparição correta na tabela de projetos com badge visual dedicado.
- **Acionamento do Backup de Storage**:
  - Clicar no botão "Executar Agora" na UI para o projeto de Storage.
  - Verificar log gerado com status `IN_PROGRESS` e subsequente transição para `SUCCESS`.
  - Checar métricas registradas (tamanho do pacote gerado e tempo de execução).
- **Compatibilidade Retroativa com Backups de Banco**:
  - Criar ou disparar um backup de PostgreSQL existente.
  - Confirmar que o fluxo original de `pg_dump` continua funcionando com 100% de precisão.

---

## 6. Revisão do Usuário & Decisões de Design

> [!IMPORTANT]
> **Aprovação do Novo Nome**:
> Sugerimos adotar **VaultFlow** como nome oficial do projeto, atualizando cabeçalhos, layout e documentação. Se preferir outra opção (como *OmniBackup* ou manter *DumpFlow*), favor indicar.

> [!NOTE]
> **Compatibilidade Retroativa**:
> A modelagem proposta foi desenhada para que nenhum projeto existente de PostgreSQL seja corrompido ou precise ser recriado. Todos os projetos existentes herdam automaticamente `type = 'DATABASE'`.
