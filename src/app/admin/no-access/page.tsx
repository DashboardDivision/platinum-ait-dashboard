import { Shell } from "@/components/shell";
import { requirePageUser } from "@/server/session";

export const metadata = { title: "No access" };

export default async function NoAccess() {
  const u = await requirePageUser("admin");
  return (
    <Shell user={u} active="">
      <div className="topbar"><div><h1>No access</h1></div></div>
      <p className="alert warn">Your role doesn't include this page. Ask the Master Admin if you need it.</p>
    </Shell>
  );
}
