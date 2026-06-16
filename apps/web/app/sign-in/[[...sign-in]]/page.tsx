import { SignIn } from "@clerk/nextjs";
import { AuthShell } from "../../../components/auth/auth-shell";
import { authClerkAppearance } from "../../../components/auth/clerk-appearance";

export default function SignInPage() {
  return (
    <div data-testid="sign-in-page">
      <AuthShell
        badge="Welcome back"
        title="Pick up right where you left off."
        description="Return to your calm dashboard — your goals, habits, reminders, and AI insights are exactly where you left them."
        alternateHref="/sign-up"
        alternateLabel="Create account"
      >
        <SignIn
          forceRedirectUrl="/dashboard"
          signUpUrl="/sign-up"
          appearance={authClerkAppearance}
        />
      </AuthShell>
    </div>
  );
}
