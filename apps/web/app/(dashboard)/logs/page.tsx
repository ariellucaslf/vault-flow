import { prisma } from "@vault-flow/db";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Activity,
  Database,
  HardDrive,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { formatBytes } from "../../../lib/utils";

export default async function LogsPage() {
  const logs = await prisma.backupLog.findMany({
    include: {
      project: {
        select: {
          id: true,
          name: true,
          type: true,
        },
      },
    },
    orderBy: { executedAt: "desc" },
    take: 100,
  });

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
          <Activity className="w-8 h-8 text-blue-500" />
          Histórico de Backups
        </h1>
        <p className="text-neutral-400 mt-1">
          Acompanhe execuções manuais e agendadas, integridade (SHA-256), objetos gerados e instruções de restauração.
        </p>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-5 text-xs text-neutral-300 space-y-2">
        <div className="flex items-center gap-2 font-semibold text-white">
          <ShieldCheck className="w-4 h-4 text-emerald-400" />
          <span>Como localizar e restaurar um artefato de backup</span>
        </div>
        <p className="text-neutral-400">
          Cada execução concluída registra a URI do objeto remoto (ex: <code className="text-neutral-200">s3://bucket/arquivo.dump</code>) e seu hash <code className="text-neutral-200">SHA-256</code>. Após baixar o arquivo do seu bucket/destino e conferir o hash (<code className="text-neutral-200">shasum -a 256 arquivo</code>):
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 font-mono text-[11px]">
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-3">
            <span className="text-blue-400 font-sans font-semibold block mb-1">Restauração PostgreSQL (.dump):</span>
            <code>pg_restore --clean --if-exists --no-owner --no-privileges -d &quot;$TARGET_DB_URL&quot; backup.dump</code>
          </div>
          <div className="bg-neutral-950 border border-neutral-800 rounded-xl p-3">
            <span className="text-purple-400 font-sans font-semibold block mb-1">Inspeção e Extração Storage (.tar.gz):</span>
            <code>tar -tzf backup.tar.gz &amp;&amp; mkdir -p ./restore &amp;&amp; tar -xzf backup.tar.gz -C ./restore</code>
          </div>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-neutral-400">
            <thead className="bg-neutral-900/50 text-neutral-500 font-medium border-b border-neutral-800">
              <tr>
                <th className="px-6 py-4">Data / Origem</th>
                <th className="px-6 py-4">Projeto</th>
                <th className="px-6 py-4">Tipo</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4">Tamanho</th>
                <th className="px-6 py-4">Artefato / Detalhes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-neutral-500">
                    Nenhum backup executado ainda.
                  </td>
                </tr>
              ) : (
                logs.map((log) => {
                  const isStorage = log.project?.type === "STORAGE";
                  return (
                    <tr key={log.id} className="hover:bg-neutral-800/50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex flex-col gap-1">
                          <span className="text-neutral-200">
                            {format(new Date(log.executedAt), "dd 'de' MMM, HH:mm:ss", { locale: ptBR })}
                          </span>
                          <span className="text-[10px] uppercase tracking-wider font-semibold text-neutral-500">
                            {log.triggerType === "SCHEDULED" ? "Agendado (Cron)" : "Disparo Manual"}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4 font-medium text-white">
                        {log.project?.name || "Projeto Deletado"}
                      </td>
                      <td className="px-6 py-4">
                        {isStorage ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
                            <HardDrive className="w-3.5 h-3.5" />
                            Storage
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                            <Database className="w-3.5 h-3.5" />
                            Banco
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {log.status === "SUCCESS" && (
                          <span className="flex items-center gap-2 text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2.5 py-1 rounded-full w-fit text-xs font-medium">
                            <CheckCircle2 className="w-4 h-4" /> Sucesso
                          </span>
                        )}
                        {log.status === "FAILED" && (
                          <span className="flex items-center gap-2 text-red-400 bg-red-400/10 border border-red-400/20 px-2.5 py-1 rounded-full w-fit text-xs font-medium">
                            <XCircle className="w-4 h-4" /> Falha
                          </span>
                        )}
                        {log.status === "IN_PROGRESS" && (
                          <span className="flex items-center gap-2 text-blue-400 bg-blue-400/10 border border-blue-400/20 px-2.5 py-1 rounded-full w-fit text-xs font-medium">
                            <Clock className="w-4 h-4 animate-pulse" /> Em Progresso
                          </span>
                        )}
                        {log.status === "SKIPPED_BUSY" && (
                          <span className="flex items-center gap-2 text-amber-400 bg-amber-400/10 border border-amber-400/20 px-2.5 py-1 rounded-full w-fit text-xs font-medium">
                            <AlertTriangle className="w-4 h-4" /> Ocupado (Ignorado)
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-col">
                          <span className="font-medium text-white">{formatBytes(log.fileSize)}</span>
                          {log.fileCount !== null && log.fileCount !== undefined && (
                            <span className="text-xs text-neutral-500">
                              {log.fileCount} {log.fileCount === 1 ? "arquivo" : "arquivos"}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {log.errorMessage ? (
                          <span
                            className="text-red-400/90 text-xs max-w-[320px] block break-words"
                            title={log.errorMessage}
                          >
                            {log.errorMessage}
                          </span>
                        ) : log.artifactKey ? (
                          <div className="flex flex-col gap-1 max-w-[340px]">
                            <span
                              className="text-xs font-mono text-emerald-300/90 truncate"
                              title={log.artifactKey}
                            >
                              {log.artifactKey}
                            </span>
                            {log.checksumSha256 && (
                              <span
                                className="text-[11px] font-mono text-neutral-500 truncate"
                                title={`SHA-256: ${log.checksumSha256}`}
                              >
                                sha256: {log.checksumSha256.slice(0, 16)}…
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-neutral-500">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
