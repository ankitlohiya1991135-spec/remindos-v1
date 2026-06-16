export const authClerkAppearance = {
  variables: {
    colorPrimary: "#2563eb",
    colorText: "#0f172a",
    colorBackground: "#ffffff",
    colorInputBackground: "#f8fafc",
    colorInputText: "#0f172a",
    borderRadius: "1rem",
  },
  elements: {
    rootBox: "w-full",
    cardBox: "w-full shadow-none",
    card: "w-full border-0 bg-transparent p-0 shadow-none",
    headerTitle: "hidden",
    headerSubtitle: "hidden",
    socialButtonsBlockButton:
      "min-h-11 rounded-2xl border border-slate-200 bg-white text-sm font-medium text-slate-700 shadow-none transition hover:bg-slate-50",
    socialButtonsBlockButtonText: "text-sm font-medium text-slate-700",
    dividerLine: "bg-slate-200",
    dividerText:
      "text-[10px] font-semibold uppercase tracking-[0.28em] text-slate-400",
    formFieldLabel: "text-sm font-medium text-slate-700",
    formFieldInput:
      "min-h-11 rounded-2xl border border-slate-200 bg-slate-50 px-4 text-sm text-slate-900 shadow-none transition placeholder:text-slate-400 focus:border-blue-500 focus:bg-white focus:ring-0",
    formFieldSuccessText: "text-xs text-emerald-600",
    formFieldErrorText: "text-xs text-rose-600",
    formButtonPrimary:
      "min-h-11 rounded-2xl bg-blue-600 text-sm font-semibold text-white shadow-none transition hover:bg-blue-500",
    footerAction: "justify-center",
    footerActionText: "text-sm text-slate-500",
    footerActionLink:
      "text-sm font-semibold text-blue-600 hover:text-blue-700",
    identityPreviewEditButton:
      "text-sm font-semibold text-blue-600 hover:text-blue-700",
    formResendCodeLink: "font-semibold text-blue-600 hover:text-blue-700",
    otpCodeFieldInput:
      "h-12 rounded-2xl border border-slate-200 bg-slate-50 text-slate-900 shadow-none focus:border-blue-500 focus:bg-white focus:ring-0",
    alertText: "text-sm text-rose-600",
    alternativeMethodsBlockButton:
      "rounded-2xl border border-slate-200 bg-slate-50 text-sm font-medium text-slate-700 transition hover:bg-white",
  },
} as const;
