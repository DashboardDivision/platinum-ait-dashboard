import { AgentSection } from "@/components/agent-section";

export const metadata = { title: "Operation Free Agent" };

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; after?: string; added?: string; type?: string; deleted?: string }> }) {
  return <AgentSection program="free_agent" searchParams={await searchParams} />;
}
