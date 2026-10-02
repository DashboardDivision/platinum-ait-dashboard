import { AuthBrand } from "@/components/brand";
import { ResetForm } from "./form";

export const metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string; error?: string }> }) {
  const { token, error } = await searchParams;
  return (
    <div className="auth">
      <div className="auth-card">
        <AuthBrand />
        <h1>Choose a new password</h1>
        {!token || error ? (
          <p className="alert bad" role="alert">
            This reset link has expired or was already used. <a href="/forgot-password">Ask for a new link</a>.
          </p>
        ) : (
          <ResetForm token={token} />
        )}
      </div>
    </div>
  );
}
