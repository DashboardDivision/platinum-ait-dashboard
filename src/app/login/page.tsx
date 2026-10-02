import { redirect } from "next/navigation";
import { AuthBrand } from "@/components/brand";
import { getCurrentUser } from "@/server/session";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  return (
    <div className="auth">
      <div className="auth-card">
        <AuthBrand />
        <h1>Sign in</h1>
        <p className="lead">Use your email and password. First time here? Your temporary password is your phone number, numbers only.</p>
        <LoginForm />
        <p className="auth-foot">
          <a href="/forgot-password">Forgot password?</a>
        </p>
      </div>
    </div>
  );
}
