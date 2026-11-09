"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Play,
  Trash2,
  PauseCircle,
  PlayCircle,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
} from "lucide-react";
import {
  deleteProject,
  toggleProjectEnabled,
  triggerBackupAction,
} from "../../actions/project.actions";

interface ProjectRowActionsProps {
  projectId: string;
  projectName: string;
  enabled: boolean;
}

export function ProjectRowActions({
  projectId,
  projectName,
  enabled,
}: ProjectRowActionsProps) {
  const router = useRouter();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [isTriggering, setIsTriggering] = useState(false);
  const [isToggling, setIsToggling] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [feedback, setFeedback] = useState<{
    status: "ACCEPTED" | "BUSY" | "FAILED" | "INFO";
    text: string;
  } | null>(null);

  async function handleTriggerBackup() {
    if (isTriggering) return;
    setIsTriggering(true);
    setFeedback(null);

    try {
      const result = await triggerBackupAction(projectId);

      if (result.status === "ACCEPTED") {
        const shortLogId = result.logId ? `#${result.logId.slice(0, 8)}` : "";
        setFeedback({
          status: "ACCEPTED",
          text: `Aceito ${shortLogId} • Execução em andamento`,
        });

        // Atualização limitada do histórico após disparo aceito (sem polling infinito)
        setTimeout(() => {
          router.refresh();
        }, 2500);
        setTimeout(() => {
          router.refresh();
        }, 7000);
      } else if (result.status === "BUSY") {
        setFeedback({
          status: "BUSY",
          text: result.error || "Ocupado • Já existe um backup em execução.",
        });
      } else {
        setFeedback({
          status: "FAILED",
          text: result.error || "Falha ao solicitar execução de backup.",
        });
      }
    } finally {
      setIsTriggering(false);
    }
  }

  async function handleToggleEnabled() {
    if (isToggling) return;
    setIsToggling(true);
    setFeedback(null);

    try {
      const nextState = !enabled;
      const res = await toggleProjectEnabled(projectId, nextState);
      if (res.error) {
        setFeedback({
          status: "FAILED",
          text: res.error,
        });
      } else {
        setFeedback({
          status: "INFO",
          text: nextState ? "Agendamento reativado" : "Agendamento pausado",
        });
        router.refresh();
      }
    } finally {
      setIsToggling(false);
    }
  }

  async function handleConfirmDelete() {
    if (isDeleting) return;
    setIsDeleting(true);

    try {
      const res = await deleteProject(projectId);
      dialogRef.current?.close();
      if (res.error) {
        setFeedback({
          status: "FAILED",
          text: res.error,
        });
        setIsDeleting(false);
      } else {
        router.refresh();
      }
    } catch {
      setFeedback({
        status: "FAILED",
        text: "Erro inesperado ao excluir projeto.",
      });
      setIsDeleting(false);
    }
  }

  const dialogTitleId = `delete-dialog-title-${projectId}`;

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center justify-end gap-1">
        <button
          type="button"
          onClick={handleTriggerBackup}
          disabled={isTriggering}
          title="Executar Agora (Forçar Backup Imediato)"
          className="p-2 text-emerald-400 hover:bg-emerald-500/10 rounded-lg transition-colors disabled:opacity-50"
        >
          {isTriggering ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Play className="w-4 h-4" />
          )}
        </button>

        <button
          type="button"
          onClick={handleToggleEnabled}
          disabled={isToggling}
          title={
            enabled
              ? "Pausar Agendamento Automático (Cron)"
              : "Reativar Agendamento Automático (Cron)"
          }
          className={`p-2 rounded-lg transition-colors disabled:opacity-50 ${
            enabled
              ? "text-amber-400 hover:bg-amber-500/10"
              : "text-blue-400 hover:bg-blue-500/10"
          }`}
        >
          {isToggling ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : enabled ? (
            <PauseCircle className="w-4 h-4" />
          ) : (
            <PlayCircle className="w-4 h-4" />
          )}
        </button>

        <button
          type="button"
          onClick={() => dialogRef.current?.showModal()}
          disabled={isDeleting}
          title="Excluir Projeto"
          className="p-2 text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>

      {feedback && (
        <div
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border max-w-xs text-right ${
            feedback.status === "ACCEPTED"
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
              : feedback.status === "BUSY"
              ? "bg-amber-500/10 border-amber-500/30 text-amber-300"
              : feedback.status === "INFO"
              ? "bg-blue-500/10 border-blue-500/30 text-blue-300"
              : "bg-red-500/10 border-red-500/30 text-red-300"
          }`}
        >
          {feedback.status === "ACCEPTED" && (
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
          )}
          {feedback.status === "BUSY" && (
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          )}
          {feedback.status === "FAILED" && (
            <XCircle className="w-3.5 h-3.5 shrink-0" />
          )}
          <span>{feedback.text}</span>
        </div>
      )}

      <dialog
        ref={dialogRef}
        aria-labelledby={dialogTitleId}
        className="m-auto bg-neutral-900 border border-neutral-800 text-neutral-200 rounded-2xl p-6 max-w-md w-full shadow-2xl text-left"
      >
        <h2 id={dialogTitleId} className="text-lg font-semibold text-white">
          Excluir projeto &ldquo;{projectName}&rdquo;?
        </h2>
        <div className="mt-3 space-y-2 text-xs text-neutral-400 leading-relaxed">
          <p>
            Esta ação cancelará o agendamento automático (Cron) imediatamente e removerá
            a configuração e os registros de histórico vinculados a este projeto no painel.
          </p>
          <p className="text-amber-400/90 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
            Os arquivos de backup (<code>.dump</code> / <code>.tar.gz</code>) já enviados aos
            seus destinos externos (S3 / Google Drive) <strong>não</strong> serão apagados.
          </p>
        </div>

        <form method="dialog" className="mt-6 flex items-center justify-end gap-3">
          <button
            type="submit"
            value="cancel"
            autoFocus
            disabled={isDeleting}
            className="px-4 py-2 rounded-xl text-xs font-medium bg-neutral-800 hover:bg-neutral-700 text-neutral-200 transition-colors"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleConfirmDelete}
            disabled={isDeleting}
            className="px-4 py-2 rounded-xl text-xs font-medium bg-red-600 hover:bg-red-700 text-white transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            {isDeleting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Excluindo...
              </>
            ) : (
              "Confirmar Exclusão"
            )}
          </button>
        </form>
      </dialog>
    </div>
  );
}
