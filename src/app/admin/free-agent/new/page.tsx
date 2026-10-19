import { AgentNewForm } from "@/components/agent-new";

export const metadata = { title: "Add new Free Agent" };

export default async function Page() {
  return <AgentNewForm program="free_agent" />;
}
