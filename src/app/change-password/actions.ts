"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { changePassword } from "@/server/account";
import { getCurrentUser, homeFor, HttpError } from "@/server/session";
import type { ActionState } from "@/components/action-form";

export async function changePasswordAction(_: ActionState, data: FormData): Promise<ActionState> {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  const next = String(data.get("newPassword") ?? "");
  if (next !== String(data.get("confirm") ?? "")) return { error: "The two new passwords don't match." };
  try {
    await changePassword({ userId: u.id, currentPassword: String(data.get("currentPassword") ?? ""), newPassword: next, headers: await headers(), impersonatedBy: u.impersonatedBy });
  } catch (e) {
    return { error: e instanceof HttpError ? e.message : "Something went wrong. Try again." };
  }
  redirect(u.role === "admin" ? homeFor(u) : `${homeFor(u)}?welcome=1`);
}
