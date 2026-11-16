/** Bearer session token storage (better-auth bearer plugin). One tab broadcasts to the others. */
const KEY = "ap.token";
type Listener = (token: string | null) => void;
const listeners = new Set<Listener>();

export const session = {
  get(): string | null {
    return localStorage.getItem(KEY);
  },
  set(token: string | null) {
    if (token) localStorage.setItem(KEY, token);
    else localStorage.removeItem(KEY);
    for (const l of listeners) l(token);
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) for (const l of listeners) l(e.newValue);
  });
}

/** Fired when any request returns 401 while we believed we were signed in (§13.4 会话过期). */
export const sessionExpired = new EventTarget();
