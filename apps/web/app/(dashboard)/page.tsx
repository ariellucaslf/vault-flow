import { getServerSession } from "next-auth";
import { authOptions } from "../../lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@vault-flow/db";
import { Database, HardDrive, Clock, Activity, CheckCircle2, XCircle } from "lucide-react";
import { formatBytes } from "../../lib/utils";

export default async function Dashboard() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/auth/login");

  const [dbProjectsCount, storageProjectsCount, logsCount, successCount, latestLogs] = await Promise.all([
    prisma.project.count({ where: { type: "DATABASE" } }),
    prisma.project.count({ where: { type: "STORAGE" } }),
    prisma.backupLog.count(),
    prisma.backupLog.count({ where: { status: "SUCCESS" } }),
    prisma.backupLog.findMany({
      take: 6,
      orderBy: { executedAt: "desc" },
      include: { project: true },
    }),
  ]);

  const healthRate = logsCount > 0 ? Math.round((successCount / logsCount) * 100) : 100;

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white tracking-tight">Visão Geral</h1>
        <p className="text-neutral-400 mt-1">Painel unificado de monitoramento e orquestração de backups (VaultFlow).</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-sm hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-400">Bancos de Dados</h3>
            <div className="p-2 bg-blue-500/10 text-blue-400 rounded-lg border border-blue-500/20">
              <Database className="w-4 h-4" />
            </div>
          </div>
          <p className="text-3xl font-semibold text-white mt-4">{dbProjectsCount}</p>
          <p className="text-xs text-neutral-500 mt-1">Instâncias PostgreSQL</p>
        </div>
        
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-sm hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-400">Storages Protegidos</h3>
            <div className="p-2 bg-purple-500/10 text-purple-400 rounded-lg border border-purple-500/20">
              <HardDrive className="w-4 h-4" />
            </div>
          </div>
          <p className="text-3xl font-semibold text-white mt-4">{storageProjectsCount}</p>
          <p className="text-xs text-neutral-500 mt-1">S3, MinIO, GDrive & Local</p>
        </div>
        
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-sm hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-400">Backups Executados</h3>
            <div className="p-2 bg-amber-500/10 text-amber-400 rounded-lg border border-amber-500/20">
              <Clock className="w-4 h-4" />
            </div>
          </div>
          <p className="text-3xl font-semibold text-white mt-4">{logsCount}</p>
          <p className="text-xs text-neutral-500 mt-1">{successCount} com sucesso</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-sm hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-400">Taxa de Sucesso</h3>
            <div className="p-2 bg-emerald-500/10 text-emerald-400 rounded-lg border border-emerald-500/20">
              <Activity className="w-4 h-4" />
            </div>
          </div>
          <p className="text-3xl font-semibold text-emerald-400 mt-4">{healthRate}%</p>
          <p className="text-xs text-neutral-500 mt-1">Saúde global do sistema</p>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-neutral-800 bg-neutral-900/50">
          <h3 className="text-lg font-medium text-white">Últimas Execuções de Backup</h3>
        </div>
        <div className="divide-y divide-neutral-800">
          {latestLogs.length === 0 ? (
            <div className="p-12 flex flex-col items-center justify-center text-neutral-500">
              <HardDrive className="w-8 h-8 mb-4 opacity-20" />
              <p>Nenhum backup executado ainda.</p>
            </div>
          ) : (
            latestLogs.map((log) => {
              const isStorage = log.project?.type === "STORAGE";

              return (
                <div key={log.id} className="p-5 flex items-center justify-between hover:bg-neutral-800/50 transition-colors group">
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg border ${
                      isStorage
                        ? "bg-purple-500/10 border-purple-500/20 text-purple-400"
                        : "bg-blue-500/10 border-blue-500/20 text-blue-400"
                    }`}>
                      {isStorage ? <HardDrive className="w-4 h-4" /> : <Database className="w-4 h-4" />}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-white group-hover:text-blue-400 transition-colors">
                          {log.project?.name || "Projeto Deletado"}
                        </p>
                        <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-neutral-800 text-neutral-400 border border-neutral-700">
                          {isStorage ? "Storage" : "Banco"}
                        </span>
                      </div>
                      <p className="text-xs text-neutral-400 mt-0.5">
                        {new Date(log.executedAt).toLocaleString("pt-BR")}
                        {log.fileSize ? ` • ${formatBytes(log.fileSize)}` : ""}
                        {log.fileCount ? ` (${log.fileCount} arquivos)` : ""}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    {log.status === "SUCCESS" ? (
                      <span className="px-3 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-xs font-medium flex items-center gap-1.5">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        Sucesso
                      </span>
                    ) : log.status === "FAILED" ? (
                      <span className="px-3 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded-full text-xs font-medium flex items-center gap-1.5">
                        <XCircle className="w-3.5 h-3.5" />
                        Falha
                      </span>
                    ) : (
                      <span className="px-3 py-1 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full text-xs font-medium flex items-center gap-1.5">
                        <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
                        Em Progresso
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
