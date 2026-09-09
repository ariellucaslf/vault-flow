import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "12px" }}>
          <h1 style={{ fontSize: "2.5rem", fontWeight: "bold", letterSpacing: "-0.03em" }}>VaultFlow Docs</h1>
          <p style={{ color: "#888", maxWidth: "600px", fontSize: "1rem", lineHeight: "1.6" }}>
            Documentação técnica oficial da arquitetura, motor de streaming e provedores de backup (PostgreSQL e Storage).
          </p>
        </div>

        <ol>
          <li>
            <strong>apps/api</strong>: Motor de backup em streaming (PostgreSQL, S3, MinIO, GDrive, Local).
          </li>
          <li>
            <strong>apps/web</strong>: Painel administrativo Next.js 15 com autenticação e agendador Cron.
          </li>
          <li>
            <strong>packages/db</strong>: Camada de dados centralizada com Prisma ORM e PostgreSQL.
          </li>
        </ol>

        <div className={styles.ctas}>
          <a
            className={styles.primary}
            href="https://github.com/ariellucaslf/vault-flow"
            target="_blank"
            rel="noopener noreferrer"
          >
            Repositório no GitHub
          </a>
          <a
            href="http://localhost:3000"
            className={styles.secondary}
          >
            Acessar Painel Web
          </a>
        </div>
      </main>

      <footer className={styles.footer}>
        <span>VaultFlow — Plataforma Open-Source de Proteção de Dados</span>
      </footer>
    </div>
  );
}
