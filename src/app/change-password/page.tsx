import { redirect } from "next/navigation";
import { AuthBrand } from "@/components/brand";
import { ActionForm } from "@/components/action-form";
import { getCurrentUser, homeFor } from "@/server/session";
import { changePasswordAction } from "./actions";
import { SignOutButton } from "@/components/sign-out";

export const metadata = { title: "Change your password" };

export default async function ChangePasswordPage() {
  const u = await getCurrentUser();
  if (!u) redirect("/login");
  if (u.impersonatedBy) redirect(homeFor(u));
  return (
    <div className="auth">
      <div className="auth-card">
        <AuthBrand />
        <h1>{u.mustChangePassword ? "Choose your own password" : "Change password"}</h1>
        <p className="lead">
          {u.mustChangePassword
            ? u.role === "recruit"
              ? "You signed in with your temporary password. Choose a new one to continue. This only changes your dashboard password; the study site has its own."
              : "You signed in with your temporary password. Choose a new one to continue."
            : "This changes your dashboard password only."}
        </p>
        <ActionForm action={changePasswordAction} submit="Save password">
          <label className="f">
            {u.mustChangePassword ? "Temporary password (your phone number)" : "Current password"}
            <input type="password" name="currentPassword" autoComplete="current-password" required autoFocus />
          </label>
          <label className="f">
            New password <span className="hint">At least 10 characters. Not your phone number.</span>
            <input type="password" name="newPassword" autoComplete="new-password" minLength={10} required />
          </label>
          <label className="f">
            Confirm new password
            <input type="password" name="confirm" autoComplete="new-password" minLength={10} required />
          </label>
        </ActionForm>
        <p className="auth-foot">
          <SignOutButton />
        </p>
      </div>
    </div>
  );
}
