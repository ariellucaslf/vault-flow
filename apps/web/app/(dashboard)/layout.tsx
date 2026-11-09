import { Database, Home, Settings, Activity, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { getServerSession } from "next-auth";
import { authOptions } from "../../lib/auth";
import { redirect } from "next/navigation";
import { UserAccountMenu } from "./user-menu";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  
  if (!session) redirect("/auth/login");

  return (
    <div className="flex h-screen bg-neutral-950 overflow-hidden">
      {/* Sidebar Fixo */}
      <aside className="w-64 border-r border-neutral-800 bg-neutral-950 p-6 flex flex-col justify-between shrink-0 z-10">
        <div className="space-y-8">
          <div className="flex items-center gap-3 px-2">
            <div className="w-8 h-8 bg-blue-500/10 rounded-lg flex items-center justify-center border border-blue-500/20">
              <ShieldCheck className="w-4 h-4 text-blue-400" />
            </div>
            <span className="font-semibold text-white tracking-tight">VaultFlow</span>
          </div>
          
          <nav className="flex flex-col gap-2">
            <Link href="/" className="flex items-center gap-3 px-3 py-2.5 text-neutral-400 hover:text-white hover:bg-neutral-900 rounded-xl transition-all">
              <Home className="w-4 h-4" />
              <span className="text-sm font-medium">Visão Geral</span>
            </Link>
            <Link href="/projects" className="flex items-center gap-3 px-3 py-2.5 text-neutral-400 hover:text-white hover:bg-neutral-900 rounded-xl transition-all">
              <Database className="w-4 h-4" />
              <span className="text-sm font-medium">Projetos</span>
            </Link>
            <Link href="/logs" className="flex items-center gap-3 px-3 py-2.5 text-neutral-400 hover:text-white hover:bg-neutral-900 rounded-xl transition-all">
              <Activity className="w-4 h-4" />
              <span className="text-sm font-medium">Histórico</span>
            </Link>
            <Link href="#" className="flex items-center gap-3 px-3 py-2.5 text-neutral-600 cursor-not-allowed rounded-xl transition-all">
              <Settings className="w-4 h-4" />
              <span className="text-sm font-medium">Configurações</span>
            </Link>
          </nav>
        </div>

        {/* Menu do Usuário Inferior */}
        <UserAccountMenu username={session.user?.name || "Admin"} />
      </aside>

      {/* Conteúdo Principal (com scroll independente) */}
      <main className="flex-1 overflow-y-auto bg-neutral-900/20 relative">
        <div className="absolute top-0 left-0 w-full h-96 bg-gradient-to-b from-blue-900/5 to-transparent pointer-events-none" />
        <div className="relative z-10 min-h-full">
          {children}
        </div>
      </main>
    </div>
  );
}
