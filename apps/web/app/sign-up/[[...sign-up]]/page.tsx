import { SignUp } from "@clerk/nextjs";
import { AuthShell } from "../../../components/auth/auth-shell";
import { authClerkAppearance } from "../../../components/auth/clerk-appearance";

export default function SignUpPage() {
  return (
    <div data-testid="sign-up-page">
      <AuthShell
        badge="The Personal Operating System"
        title="Your entire life. One dashboard."
        description="Goals, habits, health, finances, and AI-powered insights — organized into a single, calm operating system for your future self."
        alternateHref="/sign-in"
        alternateLabel="Sign in"
      >
        <SignUp
          forceRedirectUrl="/dashboard"
          signInUrl="/sign-in"
          appearance={authClerkAppearance}
        />
      </AuthShell>
    </div>
  );
}
