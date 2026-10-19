import { AgentSection } from "@/components/agent-section";

export const metadata = { title: "Agency Group Sell" };

export default async function Page({ searchParams }: { searchParams: Promise<{ q?: string; after?: string; added?: string; type?: string; deleted?: string }> }) {
  return <AgentSection program="group_sell" searchParams={await searchParams} />;
}
