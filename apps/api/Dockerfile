# Base Alpine super leve
FROM node:20-alpine AS builder
RUN apk update && apk add --no-cache libc6-compat
WORKDIR /app
RUN npm install -g turbo
# Copia todo o monorepo
COPY . .
# Extrai apenas as dependências do apps/api e pacotes locais que ele usa (@vault-flow/db)
RUN turbo prune --scope=@vault-flow/api --docker

FROM node:20-alpine AS installer
RUN apk update && apk add --no-cache libc6-compat
WORKDIR /app
COPY .gitignore .gitignore
COPY --from=builder /app/out/json/ .
COPY --from=builder /app/out/package-lock.json ./package-lock.json
# Instala as dependências de produção
RUN npm install
COPY --from=builder /app/out/full/ .
# Gera os arquivos do Prisma no node_modules
RUN npm run generate -w @vault-flow/db
# Faz o build via Turborepo
RUN npx turbo run build --filter=@vault-flow/api

FROM node:20-alpine AS runner

# ==============================================================================
# IMPORTANTE: O SEGREDO ESTÁ AQUI
# Instala o client do PostgreSQL nativo no Linux (fornece o comando pg_dump)
# Sem isso, o backend daria erro "command not found: pg_dump"
# ==============================================================================
RUN apk update && apk add --no-cache postgresql-client

WORKDIR /app

# Cria um usuário não-root por segurança
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 api_user

# Copia os arquivos gerados no step anterior (installer) para a imagem final
COPY --from=installer --chown=api_user:nodejs /app .

USER api_user

EXPOSE 4000
ENV PORT=4000
ENV NODE_ENV=production

# Inicializa o backend compilado
CMD ["npm", "run", "start", "-w", "@vault-flow/api"]
