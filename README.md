<p align="center">
  <br>
  <h1 align="center">DumpFlow </h1>
  <p align="center">
    <strong>Automação Inteligente de Backups para PostgreSQL</strong>
  </p>
  <p align="center">
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  </p>
</p>

O **DumpFlow** é uma solução open-source projetada para desenvolvedores e equipes que precisam automatizar o processo de dump (cópia de segurança) de seus bancos de dados PostgreSQL e enviá-los de forma segura para provedores de nuvem (AWS S3 ou Google Drive) de maneira programada e assíncrona.

Ao invés de criar dezenas de scripts Bash soltos em servidores diferentes, o DumpFlow oferece um Painel de Controle (Dashboard) moderno e unificado.

## Tecnologias Principais

- **Frontend (Painel)**: Next.js (App Router), Tailwind CSS v4, Lucide Icons, NextAuth.
- **Backend (Motor de Backup)**: Node.js (TypeScript), Express, `pg_dump`, `node-cron`.
- **Banco de Dados (Metadados)**: PostgreSQL com Prisma ORM.
- **Arquitetura**: Monorepo gerenciado com Turborepo.

## Funcionalidades

- **Painel Protegido**: Autenticação segura via banco de dados (Bcrypt + NextAuth).
- **Múltiplos Projetos**: Cadastre quantos bancos PostgreSQL desejar.
- **Histórico de Logs**: Acompanhe o sucesso ou falha de cada backup gerado diretamente no painel.
- **Agendamento Cron Avançado**: Defina de hora em hora, diariamente ou semanalmente. Suporte visual em tempo real para a tradução do Cron.
- **Gatilho Manual**: Force o backup de um projeto instantaneamente via UI (Server-to-Server trigger seguro).
- **Múltiplos Destinos na Nuvem**: 
  - **AWS S3** (Via Multipart Upload).
  - **Google Drive** (Via Service Accounts e `googleapis`).
- **Upload via Streaming**: O backup nunca toca o disco rígido do servidor Node.js. O `pg_dump` é canalizado (Piped) diretamente para a nuvem, permitindo o backup de bancos gigantescos (Gigabytes) usando pouquíssima memória RAM.

---

## Pré-requisitos

Antes de iniciar, certifique-se de ter instalado em sua máquina ou servidor:

1. **Node.js** (v20 ou superior).
2. **PostgreSQL Client** (`pg_dump` precisa estar instalado e disponível no PATH do sistema, pois o backend irá invocá-lo).
3. Um banco de dados PostgreSQL livre para hospedar os metadados do DumpFlow.

---

## Instalação e Configuração (Setup)

**1. Clone o repositório**
```bash
git clone https://github.com/ariellucaslf/dump-flow.git
cd dump-flow
```

**2. Instale as dependências**
O projeto utiliza `npm` workspaces.
```bash
npm install
```

**3. Configure as Variáveis de Ambiente**
Na raiz do projeto (ou dentro de `apps/web`), copie o arquivo `.env.example` para `.env`:
```bash
cp .env.example .env
```
Preencha o `.env` com a URL do seu banco de dados principal (onde o Prisma salvará os dados do painel) e o `NEXTAUTH_SECRET`:
```env
DATABASE_URL="postgresql://user:password@localhost:5432/dumpflow_db?schema=public"
NEXTAUTH_SECRET="gere_uma_chave_secreta_aleatoria_aqui"
```

**4. Inicialize o Banco de Dados**
Gere os arquivos do Prisma e crie as tabelas:
```bash
npm run generate -w @dump-flow/db
npm run push -w @dump-flow/db
```

**5. Crie seu Usuário Administrador (Seed)**
Ainda no `.env`, defina suas credenciais pessoais para logar no painel:
```env
ADMIN_USERNAME="seu_usuario"
ADMIN_PASSWORD="sua_senha_segura"
```
E rode o script de Seed para inserir o usuário no banco:
```bash
npm run seed -w @dump-flow/db
```

---

## Como Executar Localmente

Com o banco de dados rodando e o usuário criado, você pode iniciar o Monorepo inteiro com um único comando:

```bash
npm run dev
```

Este comando (usando o Turborepo) irá subir simultaneamente:
- O **Servidor API e Agendador de Backups** em `http://localhost:4000`
- O **Painel Frontend (Next.js)** em `http://localhost:3000`

Acesse `http://localhost:3000`, faça o login com as credenciais criadas no passo 5, e comece a adicionar seus Projetos!

---

## Guia de Credenciais de Nuvem

No painel de "Novo Projeto", você precisará fornecer credenciais de destino em formato JSON.

### AWS S3
Crie um usuário IAM com permissão `s3:PutObject` para o seu Bucket. No formulário do DumpFlow, insira o seguinte JSON:
```json
{
  "accessKeyId": "AKIAIOSFODNN7EXAMPLE",
  "secretAccessKey": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "region": "us-east-1"
}
```

### Google Drive
1. Acesse o **Google Cloud Console**.
2. Crie uma **Service Account** (Conta de Serviço) e gere uma chave em formato **JSON**.
3. No Google Drive, crie a pasta onde quer salvar os backups e **compartilhe ela (como Editor)** com o email da Service Account criada.
4. No formulário do DumpFlow:
   - Em *Target/ID da Pasta*, coloque o ID da pasta (a sequência final na URL do Drive).
   - Em *Credenciais JSON*, copie e cole **TODO o conteúdo** do arquivo JSON baixado do Google Cloud.

---

## Deploy em Produção (Nuvem)

O DumpFlow foi arquitetado para rodar perfeitamente em serviços modernos de PaaS (Railway, Render, Fly.io, AWS ECS). 

Como o motor de backup exige que o `pg_dump` esteja nativamente instalado no sistema operacional, nós fornecemos um **Dockerfile** pronto para uso (`apps/api/Dockerfile`).

**Recomendação de Infraestrutura:**
1. **Frontend (Painel):** Hospede o `apps/web` na Vercel (Configuração padrão de Next.js).
2. **Backend (Worker):** Hospede o `apps/api` no Railway apontando para o `Dockerfile` fornecido. Ele é construído em cima do `node:20-alpine` (super leve) e instala o `postgresql-client` automaticamente.

---

## Contribuições

O DumpFlow é **Open-Source**. Sinta-se livre para fazer um Fork, reportar Issues ou abrir Pull Requests adicionando novos provedores de nuvem (como Azure Blob Storage, Cloudflare R2, Dropbox, etc).

Arquitetado e Desenvolvido por [Ariel Lucas](https://github.com/ariellucaslf).
