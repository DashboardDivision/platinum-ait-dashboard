import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/session";

export default async function Home() {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (u.mustChangePassword && !u.impersonatedBy) redirect("/change-password");
  redirect(u.role === "admin" && !u.impersonatedBy ? "/admin" : "/recruit");
}
