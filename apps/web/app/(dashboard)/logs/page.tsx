import { prisma } from "@vault-flow/db";
import { CheckCircle2, XCircle, Clock, Activity } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

export default async function LogsPage() {
  const logs = await prisma.backupLog.findMany({
    include: { project: true },
    orderBy: { executedAt: 'desc' },
    take: 100 // Limita aos últimos 100 logs para performance
  });

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
          <Activity className="w-8 h-8 text-blue-500" />
          Histórico de Backups
        </h1>
        <p className="text-neutral-400 mt-1">Acompanhe as execuções recentes e verifique possíveis falhas.</p>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-neutral-400">
            <thead className="bg-neutral-900/50 text-neutral-500 font-medium border-b border-neutral-800">
              <tr>
                <th className="px-6 py-4">Data / Hora</th>
                <th className="px-6 py-4">Projeto</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4">Tamanho</th>
                <th className="px-6 py-4">Detalhes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-neutral-500">
                    Nenhum backup executado ainda.
                  </td>
                </tr>
              ) : (
                logs.map(log => (
                  <tr key={log.id} className="hover:bg-neutral-800/50 transition-colors">
                    <td className="px-6 py-4 whitespace-nowrap">
                      {format(new Date(log.executedAt), "dd 'de' MMM, HH:mm", { locale: ptBR })}
                    </td>
                    <td className="px-6 py-4 font-medium text-white">
                      {log.project?.name || "Projeto Deletado"}
                    </td>
                    <td className="px-6 py-4">
                      {log.status === 'SUCCESS' && (
                        <span className="flex items-center gap-2 text-emerald-400 bg-emerald-400/10 border border-emerald-400/20 px-2.5 py-1 rounded-full w-fit">
                          <CheckCircle2 className="w-4 h-4" /> Sucesso
                        </span>
                      )}
                      {log.status === 'FAILED' && (
                        <span className="flex items-center gap-2 text-red-400 bg-red-400/10 border border-red-400/20 px-2.5 py-1 rounded-full w-fit">
                          <XCircle className="w-4 h-4" /> Falha
                        </span>
                      )}
                      {log.status === 'IN_PROGRESS' && (
                        <span className="flex items-center gap-2 text-blue-400 bg-blue-400/10 border border-blue-400/20 px-2.5 py-1 rounded-full w-fit">
                          <Clock className="w-4 h-4 animate-pulse" /> Em Progresso
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      {log.fileSize ? `${(log.fileSize / 1024 / 1024).toFixed(2)} MB` : '-'}
                    </td>
                    <td className="px-6 py-4">
                      {log.errorMessage ? (
                        <span className="text-red-400/80 text-xs truncate max-w-[200px] block" title={log.errorMessage}>
                          {log.errorMessage}
                        </span>
                      ) : (
                        <span className="text-neutral-500">-</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
