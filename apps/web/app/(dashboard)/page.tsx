import { getServerSession } from "next-auth";
import { authOptions } from "../../lib/auth";
import { redirect } from "next/navigation";
import { prisma } from "@vault-flow/db";
import { Database, HardDrive, Clock, Activity } from "lucide-react";

export default async function Dashboard() {
  const session = await getServerSession(authOptions);
  if (!session) redirect("/auth/login");

  // Buscando dados do banco diretamente no Server Component
  const projectCount = await prisma.project.count();
  const logsCount = await prisma.backupLog.count();
  const latestLogs = await prisma.backupLog.findMany({
    take: 5,
    orderBy: { executedAt: 'desc' },
    include: { project: true }
  });

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white tracking-tight">Visão Geral</h1>
        <p className="text-neutral-400 mt-1">Monitore o status da orquestração de backups.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-sm hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-400">Projetos Ativos</h3>
            <Database className="w-5 h-5 text-blue-500" />
          </div>
          <p className="text-3xl font-semibold text-white mt-4">{projectCount}</p>
        </div>
        
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-sm hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-400">Backups Realizados</h3>
            <HardDrive className="w-5 h-5 text-purple-500" />
          </div>
          <p className="text-3xl font-semibold text-white mt-4">{logsCount}</p>
        </div>
        
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-sm hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-400">Tarefas Agendadas</h3>
            <Clock className="w-5 h-5 text-amber-500" />
          </div>
          <p className="text-3xl font-semibold text-white mt-4">{projectCount}</p>
        </div>

        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 shadow-sm hover:border-neutral-700 transition-colors">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-neutral-400">Saúde do Sistema</h3>
            <Activity className="w-5 h-5 text-emerald-500" />
          </div>
          <p className="text-3xl font-semibold text-emerald-400 mt-4">100%</p>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-neutral-800 bg-neutral-900/50">
          <h3 className="text-lg font-medium text-white">Últimas Execuções</h3>
        </div>
        <div className="divide-y divide-neutral-800">
          {latestLogs.length === 0 ? (
            <div className="p-12 flex flex-col items-center justify-center text-neutral-500">
              <HardDrive className="w-8 h-8 mb-4 opacity-20" />
              <p>Nenhum backup executado ainda.</p>
            </div>
          ) : (
            latestLogs.map((log) => (
              <div key={log.id} className="p-6 flex items-center justify-between hover:bg-neutral-800/50 transition-colors group">
                <div>
                  <p className="text-sm font-medium text-white group-hover:text-blue-400 transition-colors">{log.project.name}</p>
                  <p className="text-xs text-neutral-400 mt-1">{new Date(log.executedAt).toLocaleString('pt-BR')}</p>
                </div>
                <div className="flex items-center gap-3">
                  {log.status === 'SUCCESS' ? (
                    <span className="px-3 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full text-xs font-medium">Sucesso</span>
                  ) : log.status === 'FAILED' ? (
                    <span className="px-3 py-1 bg-red-500/10 text-red-400 border border-red-500/20 rounded-full text-xs font-medium">Falha</span>
                  ) : (
                    <span className="px-3 py-1 bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full text-xs font-medium flex items-center gap-2">
                      <div className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-pulse" />
                      Em Progresso
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
