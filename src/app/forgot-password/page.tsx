import { AuthBrand } from "@/components/brand";
import { ForgotForm } from "./form";

export const metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <div className="auth">
      <div className="auth-card">
        <AuthBrand />
        <h1>Reset your password</h1>
        <p className="lead">We'll email you a link to choose a new dashboard password. This doesn't change your study-site password.</p>
        <ForgotForm />
        <p className="auth-foot">
          <a href="/login">Back to sign in</a>
        </p>
      </div>
    </div>
  );
}
