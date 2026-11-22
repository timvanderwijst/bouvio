import { useState } from "react";
import { backend } from "../../backend";
import { useT } from "../../i18n";
import { useStore } from "../../store";

/** The web client's front door: email code, or the code Google/GitHub sign-in shows. */
export function WebSignIn() {
  const t = useT();
  const [step, setStep] = useState<"email" | "code" | "paste">(initialSignInStep);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (step === "email") {
        await backend.hub.request("POST", "/auth/email/start", { email: email.trim() });
        setStep("code");
      } else {
        await backend.hub.signIn(step === "code" ? "/auth/email/verify" : "/auth/exchange", step === "code" ? { email: email.trim(), code: code.trim() } : { code: code.trim() });
        useStore.getState().refreshHub();
      }
    } catch (e) {
      setError(String(e).replace(/^Error: /, ""));
    } finally {
      setBusy(false);
    }
  };

  // OAuth runs in this tab; the hub's callback page shows a code to paste back here.
  const oauth = (p: "google" | "github") => {
    try {
      sessionStorage.setItem("cuna.signin.step", "paste");
    } catch {}
    location.href = `/auth/${p}/start`;
  };

  return (
    <div className="pf-signin">
      <form
        className="pf-signin-card form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <img className="pf-signin-mark" src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" width={40} height={40} />
        <h1 className="pf-signin-title">{t("platform.web.title")}</h1>
        <p className="pf-signin-lead">{t("platform.web.lead")}</p>

        {step === "email" && (
          <>
            <label className="field">
              <span>{t("platform.web.email")}</span>
              <input className="input" type="email" autoComplete="email" autoFocus required value={email} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button type="submit" className={`btn primary block ${busy ? "is-busy" : ""}`} disabled={busy || !email.trim()}>
              {t("platform.web.sendCode")}
            </button>
            <div className="or">{t("platform.web.or")}</div>
            <div className="oauth">
              <button type="button" className="btn" onClick={() => oauth("google")}>
                {t("platform.web.with", { provider: "Google" })}
              </button>
              <button type="button" className="btn" onClick={() => oauth("github")}>
                {t("platform.web.with", { provider: "GitHub" })}
              </button>
            </div>
            <button type="button" className="btn ghost small pf-signin-link" onClick={() => setStep("paste")}>
              {t("platform.web.haveCode")}
            </button>
          </>
        )}

        {(step === "code" || step === "paste") && (
          <>
            <label className="field">
              <span>{step === "code" ? t("platform.web.codeSent", { email }) : t("platform.web.pasteHint")}</span>
              <input className="input big mono center" autoFocus autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} aria-label={t("platform.web.code")} />
            </label>
            <button type="submit" className={`btn primary block ${busy ? "is-busy" : ""}`} disabled={busy || !code.trim()}>
              {t("platform.web.signIn")}
            </button>
            <button type="button" className="btn ghost small pf-signin-link" onClick={() => (setStep("email"), setCode(""), setError(null))}>
              {t("platform.web.back")}
            </button>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
      </form>
    </div>
  );
}

/** Returning from Google/GitHub: open straight on the paste step. */
function initialSignInStep(): "email" | "paste" {
  try {
    const s = sessionStorage.getItem("cuna.signin.step");
    sessionStorage.removeItem("cuna.signin.step");
    return s === "paste" ? "paste" : "email";
  } catch {
    return "email";
  }
}

/** Settings → Account in the web client: who is signed in, and a way out. */
export function WebAccount() {
  const t = useT();
  const user = useStore((s) => s.hub.user);
  return (
    <section className="set-group">
      <h2>{t("platform.web.account")}</h2>
      <div className="set-row">
        <span className="pf-col">
          <span>{user?.name ?? "–"}</span>
          {user && <span className="pf-hint">{user.email}</span>}
        </span>
        <button className="btn small" onClick={() => backend.hub.logout().catch((e) => useStore.getState().notify(String(e)))}>
          {t("platform.web.signOut")}
        </button>
      </div>
    </section>
  );
}
