"use client";

import { useState } from "react";
import { createProject } from "../../../actions/project.actions";
import { ArrowLeft, Save, Database, HardDrive } from "lucide-react";
import Link from "next/link";
import cronstrue from "cronstrue/i18n";

export default function NewProjectPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [projectType, setProjectType] = useState<"DATABASE" | "STORAGE">("DATABASE");
  const [storageType, setStorageType] = useState<"AWS_S3" | "S3_COMPATIBLE" | "GOOGLE_DRIVE" | "LOCAL_PATH">("AWS_S3");
  const [cronType, setCronType] = useState("0 3 * * *");
  const [customCron, setCustomCron] = useState("0 3 * * *");
  const [destType, setDestType] = useState("AWS_S3");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const formData = new FormData(e.currentTarget);
    formData.set("type", projectType);

    const result = await createProject(formData);

    if (result?.error) {
      setError(result.error);
      setLoading(false);
    }
  }

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-8">
      <div className="flex items-center gap-4">
        <Link href="/projects" className="p-2 hover:bg-neutral-800 rounded-full transition-colors border border-neutral-800">
          <ArrowLeft className="w-5 h-5 text-neutral-400" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Novo Projeto de Backup</h1>
          <p className="text-sm text-neutral-400">Configure a origem dos seus dados e defina a rotina automatizada de proteção.</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="p-4 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl text-sm">
            {error}
          </div>
        )}

        {/* Seletor de Tipo de Recurso */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-4">
          <h2 className="text-lg font-medium text-white mb-2">Tipo de Recurso a Proteger</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => setProjectType("DATABASE")}
              className={`flex items-center gap-4 p-4 rounded-xl border text-left transition-all ${
                projectType === "DATABASE"
                  ? "bg-blue-600/10 border-blue-500/50 text-white ring-1 ring-blue-500"
                  : "bg-neutral-950 border-neutral-800 text-neutral-400 hover:border-neutral-700"
              }`}
            >
              <div className="p-3 bg-blue-500/10 text-blue-400 rounded-xl border border-blue-500/20">
                <Database className="w-6 h-6" />
              </div>
              <div>
                <p className="font-semibold text-white">Banco de Dados</p>
                <p className="text-xs text-neutral-400 mt-0.5">PostgreSQL nativo via streaming pg_dump (.dump)</p>
              </div>
            </button>

            <button
              type="button"
              onClick={() => setProjectType("STORAGE")}
              className={`flex items-center gap-4 p-4 rounded-xl border text-left transition-all ${
                projectType === "STORAGE"
                  ? "bg-purple-600/10 border-purple-500/50 text-white ring-1 ring-purple-500"
                  : "bg-neutral-950 border-neutral-800 text-neutral-400 hover:border-neutral-700"
              }`}
            >
              <div className="p-3 bg-purple-500/10 text-purple-400 rounded-xl border border-purple-500/20">
                <HardDrive className="w-6 h-6" />
              </div>
              <div>
                <p className="font-semibold text-white">Storage / Nuvem</p>
                <p className="text-xs text-neutral-400 mt-0.5">AWS S3, MinIO, R2, GDrive ou Local (.tar.gz)</p>
              </div>
            </button>
          </div>
        </div>

        {/* Informações Gerais & Origem */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-4">
          <h2 className="text-lg font-medium text-white mb-4">
            {projectType === "DATABASE" ? "Origem: Banco de Dados PostgreSQL" : "Origem: Storage / Nuvem"}
          </h2>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1">Nome de Identificação do Projeto</label>
            <input 
              name="name" 
              required 
              type="text" 
              placeholder="Ex: SaaS Produção - Uploads"
              className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-blue-500 outline-none" 
            />
          </div>

          {projectType === "DATABASE" ? (
            <div>
              <label className="block text-sm font-medium text-neutral-300 mb-1">URL de Conexão (PostgreSQL)</label>
              <input 
                name="dbUrl" 
                required 
                type="url" 
                placeholder="postgresql://user:password@host:5432/dbname"
                className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm" 
              />
            </div>
          ) : (
            <>
              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1">Provedor do Storage de Origem</label>
                <select
                  name="storageType"
                  value={storageType}
                  onChange={(e) => setStorageType(e.target.value as "AWS_S3" | "S3_COMPATIBLE" | "GOOGLE_DRIVE" | "LOCAL_PATH")}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-purple-500 outline-none appearance-none"
                >
                  <option value="AWS_S3">Amazon S3</option>
                  <option value="S3_COMPATIBLE">S3 Compatível (MinIO, Cloudflare R2, Wasabi)</option>
                  <option value="GOOGLE_DRIVE">Google Drive</option>
                  <option value="LOCAL_PATH">Diretório Local do Servidor</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1">
                  {storageType === "AWS_S3" || storageType === "S3_COMPATIBLE"
                    ? "Nome do Bucket de Origem"
                    : storageType === "GOOGLE_DRIVE"
                    ? "ID da Pasta de Origem (Google Drive)"
                    : "Caminho Absoluto Local"}
                </label>
                <input 
                  name="storageTarget" 
                  required 
                  type="text" 
                  placeholder={
                    storageType === "AWS_S3" || storageType === "S3_COMPATIBLE"
                      ? "meu-bucket-origem"
                      : storageType === "GOOGLE_DRIVE"
                      ? "1AbCdEfGhIjKlMnOpQrStUvWxYz"
                      : "/var/www/uploads"
                  }
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-purple-500 outline-none font-mono text-sm" 
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1">Prefixo ou Subpasta Opcional</label>
                <input 
                  name="storagePrefix" 
                  type="text" 
                  placeholder="Ex: media/avatars/ ou 2026/"
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-purple-500 outline-none font-mono text-sm" 
                />
                <p className="text-xs text-neutral-500 mt-1">Deixe em branco para incluir todos os arquivos da raiz.</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-neutral-300 mb-1">Credenciais da Origem (JSON)</label>
                <p className="text-xs text-neutral-500 mb-2">
                  {storageType === "AWS_S3" && "Exemplo: {\"accessKeyId\": \"...\", \"secretAccessKey\": \"...\", \"region\": \"us-east-1\"}"}
                  {storageType === "S3_COMPATIBLE" && "Exemplo: {\"accessKeyId\": \"...\", \"secretAccessKey\": \"...\", \"endpoint\": \"https://minio.exemplo.com\", \"region\": \"us-east-1\", \"forcePathStyle\": true}"}
                  {storageType === "GOOGLE_DRIVE" && "Cole o conteúdo completo do arquivo JSON da Service Account do Google Cloud."}
                  {storageType === "LOCAL_PATH" && "Para diretório local montado, insira apenas {}."}
                </p>
                <textarea 
                  name="storageCredentials" 
                  required 
                  rows={4}
                  placeholder={storageType === "LOCAL_PATH" ? "{}" : "{\"accessKeyId\": \"...\"}"}
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white font-mono text-xs focus:ring-2 focus:ring-purple-500 outline-none resize-y" 
                />
              </div>
            </>
          )}

          {/* Agendamento Cron */}
          <div className="pt-2">
            <label className="block text-sm font-medium text-neutral-300 mb-1">Frequência de Backup Automatizada</label>
            <select 
              value={cronType}
              onChange={(e) => {
                setCronType(e.target.value);
                if (e.target.value !== "CUSTOM") {
                  setCustomCron(e.target.value);
                }
              }}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-blue-500 outline-none appearance-none mb-3"
            >
              <option value="0 * * * *">A cada 1 hora</option>
              <option value="0 */6 * * *">A cada 6 horas</option>
              <option value="0 0 * * *">Diariamente (Meia-noite)</option>
              <option value="0 3 * * *">Diariamente (Madrugada - 03:00)</option>
              <option value="0 0 * * 0">Semanalmente (Domingo)</option>
              <option value="CUSTOM">Personalizado (Expressão Cron)</option>
            </select>
            
            <input type="hidden" name="cronSchedule" value={cronType === "CUSTOM" ? customCron : cronType} />

            {cronType === "CUSTOM" && (
              <div className="mt-3 bg-neutral-950/50 p-4 rounded-xl border border-neutral-800">
                <input 
                  type="text" 
                  value={customCron}
                  onChange={(e) => setCustomCron(e.target.value)}
                  placeholder="Ex: 0 3 * * *"
                  className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white font-mono focus:ring-2 focus:ring-blue-500 outline-none" 
                />
              </div>
            )}

            <p className="mt-2 text-sm font-medium text-emerald-400 flex items-center gap-1.5">
              <span>👉</span>
              {(() => {
                try {
                  const targetCron = cronType === "CUSTOM" ? customCron : cronType;
                  let translated = cronstrue.toString(targetCron, { locale: "pt_BR", use24HourTimeFormat: true, verbose: true });
                  if (translated.startsWith("Às") || translated.startsWith("As")) {
                    translated = "Todo dia " + translated.toLowerCase();
                  }
                  return translated.charAt(0).toUpperCase() + translated.slice(1);
                } catch {
                  return "⚠️ Expressão Cron inválida ou incompleta";
                }
              })()}
            </p>
          </div>
        </div>

        {/* Destino de Armazenamento */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 space-y-4">
          <h2 className="text-lg font-medium text-white mb-4">Destino Onde Salvar a Cópia de Segurança</h2>
          
          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1">Provedor do Destino</label>
            <select 
              name="destinationType"
              value={destType}
              onChange={(e) => setDestType(e.target.value)}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-blue-500 outline-none appearance-none"
            >
              <option value="AWS_S3">Amazon S3 ou S3 Compatível</option>
              <option value="GOOGLE_DRIVE">Google Drive</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1">
              {destType === "AWS_S3" ? "Nome do Bucket de Destino" : "ID da Pasta de Destino (Google Drive)"}
            </label>
            <input 
              name="destinationTarget" 
              required 
              type="text" 
              placeholder={destType === "AWS_S3" ? "meu-vault-backups" : "1A2B3C4D5E6F7G8H9I"}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white focus:ring-2 focus:ring-blue-500 outline-none font-mono text-sm" 
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-300 mb-1">Credenciais de Autenticação do Destino (JSON)</label>
            <p className="text-xs text-neutral-500 mb-2">
              {destType === "AWS_S3" 
                ? "Exemplo: {\"accessKeyId\": \"...\", \"secretAccessKey\": \"...\", \"region\": \"us-east-1\"}" 
                : "Cole o JSON da Service Account do Google Cloud com permissão de escrita no Drive."}
            </p>
            <textarea 
              name="destinationCredentials" 
              required 
              rows={4}
              placeholder={`{"accessKeyId": "..."}`}
              className="w-full bg-neutral-950 border border-neutral-800 rounded-xl px-4 py-2.5 text-white font-mono text-xs focus:ring-2 focus:ring-blue-500 outline-none resize-y" 
            />
          </div>
        </div>

        <button 
          type="submit" 
          disabled={loading}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white font-medium py-3 rounded-xl transition-all shadow-lg shadow-blue-900/20 disabled:opacity-50 active:scale-[0.98]"
        >
          {loading ? (
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : (
            <>
              <Save className="w-5 h-5" />
              Salvar Configuração e Ativar
            </>
          )}
        </button>
      </form>
    </div>
  );
}
