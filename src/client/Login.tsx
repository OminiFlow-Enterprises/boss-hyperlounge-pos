import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { AlertBox, CapBtns } from "./BillDialogs";
import type { Actor } from "../shared/types";

const YEARS = ["2024-2025", "2025-2026", "2026-2027", "2027-2028"];

export function LoginGate({
  terminalId,
  onLogin,
  onExit,
}: {
  terminalId: string;
  onLogin: (actor: Actor, year: string) => void;
  onExit: () => void;
}) {
  const [year, setYear] = useState("2026-2027");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [changing, setChanging] = useState(false);
  const [alertText, setAlertText] = useState("");
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  const passRef = useRef<HTMLInputElement>(null);
  const afterAlert = useRef<(() => void) | null>(null);

  useEffect(() => {
    userRef.current?.focus();
    userRef.current?.select();
  }, []);

  useEffect(() => {
    function keys(e: KeyboardEvent) {
      if (document.querySelector(".alert-dlg")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (changing) setChanging(false);
        else onExit();
        return;
      }
      if (!changing && e.altKey) {
        const key = e.key.toLowerCase();
        if (key === "l") { e.preventDefault(); void submit(); }
        if (key === "c") { e.preventDefault(); setChanging(true); }
        if (key === "e") { e.preventDefault(); onExit(); }
      }
    }
    window.addEventListener("keydown", keys, true);
    return () => window.removeEventListener("keydown", keys, true);
  });

  function tell(message: string, after?: () => void) {
    afterAlert.current = after ?? null;
    setAlertText(message);
  }

  async function submit() {
    if (busy || changing) return;
    const name = username.trim();
    if (!name || !password) {
      tell("Enter username and password", () => userRef.current?.focus());
      return;
    }
    setBusy(true);
    try {
      const actor = await api.post<Actor>("/api/auth/login", { username: name, password, terminalId });
      onLogin(actor, year);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Invalid Username or Password";
      tell(message, () => passRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-mask">
      <form
        className="login-box"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="login-brand">
          <img src="/boss-logo.png" alt="THE BOSS" />
        </div>
        <div className="login-head">
          <div className="login-fields">
            <span>Financial Year :</span>
            <select className="win" data-cycle="1" value={year} onChange={(e) => setYear(e.target.value)}>
              {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <span>Username :</span>
            <input
              ref={userRef}
              className="win login-line"
              value={username}
              autoComplete="off"
              onChange={(e) => setUsername(e.target.value)}
            />
            <span>Password :</span>
            <input
              ref={passRef}
              className="win login-line"
              type="password"
              value={password}
              autoComplete="off"
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
        <div className="login-actions">
          <button type="button" onClick={() => setChanging(true)}><u>C</u>hange Password</button>
          <button type="submit"><u>L</u>ogin</button>
          <button type="button" onClick={onExit}><u>E</u>xit</button>
        </div>
        <hr className="login-rule" />
        <div className="login-script">BOSS BILLING SOFTWARE</div>
      </form>
      {changing && (
        <ChangePassword
          username={username}
          onClose={() => setChanging(false)}
          onDone={() => {
            setChanging(false);
            setPassword("");
            tell("Password changed", () => passRef.current?.focus());
          }}
          onError={(message) => tell(message)}
        />
      )}
      {alertText && (
        <AlertBox
          message={alertText}
          onClose={() => {
            setAlertText("");
            const after = afterAlert.current;
            afterAlert.current = null;
            after?.();
          }}
        />
      )}
    </div>
  );
}

function ChangePassword({
  username,
  onClose,
  onDone,
  onError,
}: {
  username: string;
  onClose: () => void;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(username);
  const [oldPassword, setOldPassword] = useState("");
  const [nextPassword, setNextPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const oldRef = useRef<HTMLInputElement>(null);

  useEffect(() => { oldRef.current?.focus(); }, []);

  async function save() {
    if (busy) return;
    if (!name.trim() || !oldPassword || !nextPassword) {
      onError("Enter username and password");
      return;
    }
    if (nextPassword !== again) {
      onError("Re-Type Password does not match");
      return;
    }
    setBusy(true);
    try {
      await api.post("/api/auth/change-password", {
        username: name.trim(),
        oldPassword,
        newPassword: nextPassword,
      });
      onDone();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : "Invalid Username or Password");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dialog pass-dlg" role="dialog" aria-label="Change Password">
      <div className="dialog-cap">
        Change Password
        <CapBtns onClose={onClose} chrome={false} />
      </div>
      <form
        className="dialog-body pass-body"
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void save();
        }}
      >
        <label><span>Username :</span><input className="win" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label><span>Old Password :</span><input ref={oldRef} className="win" type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} /></label>
        <label><span>New Password :</span><input className="win" type="password" value={nextPassword} onChange={(e) => setNextPassword(e.target.value)} /></label>
        <label><span>Re-Type Password :</span><input className="win" type="password" value={again} onChange={(e) => setAgain(e.target.value)} /></label>
        <div className="pass-actions">
          <button type="submit" className="fn">Save</button>
          <button type="button" className="fn" onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>
  );
}
