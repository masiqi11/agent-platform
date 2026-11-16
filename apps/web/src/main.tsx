import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { t } from "@/lib/i18n";
import { queryClient } from "@/lib/query";
import { realtime } from "@/lib/realtime";
import { session, sessionExpired } from "@/lib/session";
import { ThemeProvider } from "@/lib/theme";
import { ReloginForm } from "@/pages/auth";
import { router } from "./router";
import "./styles.css";

function SessionExpiredDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    sessionExpired.addEventListener("expired", on);
    return () => sessionExpired.removeEventListener("expired", on);
  }, []);
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t("session.expired.title")}</DialogTitle>
          <DialogDescription>{t("session.expired.body")}</DialogDescription>
        </DialogHeader>
        <ReloginForm onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

/** Realtime: connect when signed in; WS events invalidate the queries they affect (§13.5). */
function RealtimeBridge() {
  useEffect(() => {
    realtime.connect();
    const off = session.subscribe((tok) => (tok ? realtime.connect() : realtime.disconnect()));
    const offFrame = realtime.onFrame((f) => {
      if (f.type === "resync") void queryClient.invalidateQueries();
      if (f.type === "event" && (f.event.type.startsWith("user.") || f.event.type.startsWith("invitation."))) void queryClient.invalidateQueries({ queryKey: ["users"] });
    });
    return () => {
      off();
      offFrame();
    };
  }, []);
  return null;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delayDuration={300}>
          <RouterProvider router={router} />
          <SessionExpiredDialog />
          <RealtimeBridge />
          <Toaster position="bottom-right" />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
