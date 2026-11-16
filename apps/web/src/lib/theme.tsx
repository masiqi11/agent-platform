import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePref = "system" | "light" | "dark";
interface ThemeCtx {
  pref: ThemePref;
  resolved: "light" | "dark";
  setPref(p: ThemePref): void;
}
const Ctx = createContext<ThemeCtx>({ pref: "system", resolved: "light", setPref: () => {} });
const KEY = "ap.theme";

function systemDark() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => (localStorage.getItem(KEY) as ThemePref) || "system");
  const [sys, setSys] = useState(systemDark());
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => setSys(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  const resolved = pref === "system" ? (sys ? "dark" : "light") : pref;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);
  const value = useMemo(
    () => ({
      pref,
      resolved,
      setPref: (p: ThemePref) => {
        localStorage.setItem(KEY, p);
        setPrefState(p);
      },
    }),
    [pref, resolved],
  ) as ThemeCtx;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const useTheme = () => useContext(Ctx);
