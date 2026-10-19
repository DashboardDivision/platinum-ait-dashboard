import { AgentNewForm } from "@/components/agent-new";

export const metadata = { title: "Add new Group Sell agency" };

export default async function Page() {
  return <AgentNewForm program="group_sell" />;
}
