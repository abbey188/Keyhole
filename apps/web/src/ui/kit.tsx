// Shared pieces of the app screens (design A01 to A14): rail, top bar, safe icon, chips. Styles are docs/design/app.css + app-shell.css.
import type { ReactNode } from "react";
import "./app-shell.css";

export const Logo = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={Math.round(size * 30 / 24)} viewBox="0 0 24 30" aria-hidden="true"><rect width="24" height="30" rx="5" fill="#FFFFFF" /><circle cx="12" cy="11.5" r="4.6" fill="#0E1435" /><path d="M10.2 14.2L7.6 23.6Q7.4 24.6 8.4 24.6H15.6Q16.6 24.6 16.4 23.6L13.8 14.2Z" fill="#0E1435" /></svg>
);

const I = ({ d }: { d: ReactNode }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">{d}</svg>;
export const Icons = {
  safes: <I d={<><rect x="3" y="4" width="18" height="16" rx="4" /><circle cx="12" cy="12" r="4" /></>} />,
  verify: <I d={<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6l7-3ZM9 12l2 2 4-4" />} />,
  proof: <I d={<><rect x="3" y="9" width="7" height="6" rx="1.5" /><rect x="14" y="9" width="7" height="6" rx="1.5" /><path d="M10 12h4" /></>} />,
};

/** The safe drawn flat: rounded square, door ring, dotted dial ring, coloured plate (owner's colour), solid keyhole. */
export function SafeIcon({ color = "#2546C2", size = 56, label = "Safe" }: { color?: string; size?: number; label?: string }) {
  const light = color === "#F2A72E" || color === "#A9C2EC";
  const k = light ? "#0E1435" : "#FFFFFF";
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={label}>
      <rect x="1.5" y="1.5" width="61" height="61" rx="14" fill="#FFFFFF" stroke="#0E1435" strokeWidth="1.5" />
      <circle cx="32" cy="32" r="21" fill="none" stroke="#0E1435" strokeWidth="1.5" />
      <circle cx="32" cy="32" r="17" fill="none" stroke="#0E1435" strokeWidth="2.6" strokeDasharray="0.8 3.6" />
      <circle cx="32" cy="32" r="11.5" fill={color} />
      <circle cx="32" cy="29.6" r="3.2" fill={k} />
      <path d="M30.6 31.6L29 38.2Q28.8 39 29.6 39H34.4Q35.2 39 35 38.2L33.4 31.6Z" fill={k} />
    </svg>
  );
}

export const serialLabel = (n: number) => `#${String(n).padStart(2, "0")}`;

export interface RailSafe { boxId: string; serial: number; name: string }

/** The navy left rail with the main destinations and the owner's safes. */
export function AppShell({ active, safes = [], currentBox, onSafe, onSafes, account, crumb, actions, children }: {
  active: "safes" | "verify";
  safes?: RailSafe[];
  currentBox?: string;
  onSafe?: (boxId: string) => void;
  onSafes?: () => void;
  account?: string;
  crumb: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="app">
      <aside className="rail">
        <a className="logo" href="/"><Logo />Keyhole</a>
        {onSafes ? <button className={`ri ${active === "safes" ? "on" : ""}`} onClick={onSafes}>{Icons.safes}Safes</button> : <a className={`ri ${active === "safes" ? "on" : ""}`} href="/app">{Icons.safes}Safes</a>}
        <a className={`ri ${active === "verify" ? "on" : ""}`} href="/verify">{Icons.verify}Verify</a>
        <a className="ri" href="/proof">{Icons.proof}Proof</a>
        {safes.length > 0 && <div className="rsec">Your safes</div>}
        {safes.map((s) => (
          <button key={s.boxId} className={`rsafe ${s.boxId === currentBox ? "on" : ""}`} onClick={() => onSafe?.(s.boxId)}>
            <span>{s.name}</span><span className="m" style={{ fontSize: 11, color: "#8F98BF" }}>{serialLabel(s.serial)}</span>
          </button>
        ))}
        <div className="rfoot">
          <span className="chip" style={{ borderColor: "#F2A72E", color: "#F2A72E", alignSelf: "flex-start" }}>Testnet</span>
          {account && <span className="m" style={{ fontSize: 11, color: "#8F98BF", wordBreak: "break-all" }}>{account.length > 28 ? `${account.slice(0, 12)}…${account.slice(-8)}` : account}</span>}
        </div>
      </aside>
      <main className="main">
        <div className="top"><div className="crumb">{crumb}</div><div style={{ display: "flex", gap: 10 }}>{actions}</div></div>
        <div className="body">{children}</div>
      </main>
    </div>
  );
}

/** Tick box drawn like the design (the real input is visually hidden but focusable). */
export function Check({ on, onChange, label, children }: { on: boolean; onChange: (v: boolean) => void; label: string; children?: ReactNode }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}>
      <span style={{ position: "relative", display: "inline-flex", flex: "none" }}>
        <input type="checkbox" aria-label={label} checked={on} onChange={(e) => onChange(e.target.checked)} style={{ position: "absolute", inset: 0, margin: 0, opacity: 0, width: "100%", height: "100%", cursor: "pointer" }} />
        <span className={`check ${on ? "on" : ""}`} aria-hidden="true">{on && <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 6.2L4.8 9 10 3" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>}</span>
      </span>
      {children}
    </label>
  );
}

export const fmtClock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}`; };

/** A small spinner in ink (no shadows). */
export const Spinner = () => <span className="spin" aria-hidden="true" />;

/** Long operations shown as steps: done steps ticked, the current one spinning, later ones faint. */
export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="steps" aria-live="polite">
      {steps.map((s, i) => (
        <li key={s} className={i < current ? "done" : i === current ? "now" : "next"}>
          <span className="mark">{i < current ? <svg width="11" height="11" viewBox="0 0 12 12"><path d="M2 6.3l2.5 2.5L10 3.3" fill="none" stroke="#FFFFFF" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg> : i === current ? <Spinner /> : null}</span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

/** One-line busy state in ink, with a spinner. */
export const Working = ({ children }: { children: ReactNode }) => <span className="working"><Spinner />{children}</span>;
