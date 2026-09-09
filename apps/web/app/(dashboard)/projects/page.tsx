import { prisma } from "@vault-flow/db";
import Link from "next/link";
import { Plus, Database, HardDrive, Clock, Cloud, Trash2, Play } from "lucide-react";
import { deleteProject } from "../../actions/project.actions";
import cronstrue from "cronstrue/i18n";

export default async function ProjectsPage() {
  const projects = await prisma.project.findMany({
    include: {
      destinations: true,
      storageSource: true,
    },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-white tracking-tight">Projetos de Backup</h1>
          <p className="text-neutral-400 mt-1">Gerencie as conexões de banco de dados e rotinas de backup de storages.</p>
        </div>
        <Link 
          href="/projects/new" 
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-colors flex items-center gap-2 shadow-lg shadow-blue-900/20"
        >
          <Plus className="w-4 h-4" />
          Novo Projeto
        </Link>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-2xl shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm text-neutral-400">
            <thead className="bg-neutral-900/50 text-neutral-500 font-medium border-b border-neutral-800">
              <tr>
                <th className="px-6 py-4">Projeto / Recurso</th>
                <th className="px-6 py-4">Tipo</th>
                <th className="px-6 py-4">Agendamento (Cron)</th>
                <th className="px-6 py-4">Destinos</th>
                <th className="px-6 py-4 text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {projects.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-neutral-500">
                    Nenhum projeto configurado. Clique em &quot;Novo Projeto&quot; para começar.
                  </td>
                </tr>
              ) : (
                projects.map((project) => {
                  const isStorage = project.type === "STORAGE";

                  return (
                    <tr key={project.id} className="hover:bg-neutral-800/50 transition-colors">
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className={`p-2 rounded-lg border ${
                            isStorage
                              ? "bg-purple-500/10 border-purple-500/20 text-purple-400"
                              : "bg-blue-500/10 border-blue-500/20 text-blue-400"
                          }`}>
                            {isStorage ? <HardDrive className="w-4 h-4" /> : <Database className="w-4 h-4" />}
                          </div>
                          <div>
                            <span className="font-semibold text-white block">{project.name}</span>
                            <span className="text-xs text-neutral-500 font-mono">
                              {isStorage
                                ? `origem: ${project.storageSource?.targetFolder || "Storage"}`
                                : "PostgreSQL"}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        {isStorage ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-400 border border-purple-500/20">
                            Storage ({project.storageSource?.type || "Nuvem"})
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                            Banco de Dados
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-2" title={project.cronSchedule}>
                          <Clock className="w-4 h-4 text-neutral-500" />
                          <span className="bg-neutral-950 border border-neutral-800 px-2 py-1 rounded text-neutral-300 text-xs font-medium">
                            {(() => {
                              try {
                                let translated = cronstrue.toString(project.cronSchedule, { locale: "pt_BR", use24HourTimeFormat: true, verbose: true });
                                if (translated.startsWith("Às") || translated.startsWith("As")) {
                                  translated = "Todo dia " + translated.toLowerCase();
                                }
                                return translated.charAt(0).toUpperCase() + translated.slice(1);
                              } catch {
                                return project.cronSchedule;
                              }
                            })()}
                          </span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex flex-wrap items-center gap-1.5">
                          {project.destinations.map((d) => (
                            <span key={d.id} className="text-xs border border-purple-500/30 text-purple-400 px-2 py-0.5 rounded-full bg-purple-500/10 flex items-center gap-1">
                              <Cloud className="w-3 h-3" />
                              {d.type === "AWS_S3" ? "AWS S3" : "Google Drive"}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <form action={async () => {
                            "use server";
                            const { triggerBackupAction } = await import("../../actions/project.actions");
                            await triggerBackupAction(project.id);
                          }}>
                            <button 
                              type="submit" 
                              title="Executar Agora (Forçar Backup Imediato)" 
                              className="p-2 text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors"
                            >
                              <Play className="w-4 h-4" />
                            </button>
                          </form>
                          <form action={async () => {
                            "use server";
                            await deleteProject(project.id);
                          }}>
                            <button 
                              type="submit" 
                              title="Excluir Projeto" 
                              className="p-2 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </form>
                        </div>
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
