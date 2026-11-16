import { useEffect } from "react";
import { api, unwrap } from "./api";
import { useMe } from "./me";
import { queryClient } from "./query";
import { realtime } from "./realtime";
import { tk } from "./tasks";

export const inboxQuery = (kind: string) => ({ queryKey: tk.inbox({ kind }), queryFn: () => unwrap(api.api.v1.inbox.get({ query: kind === "all" ? {} : { kind } })) });

/** Subscribes the signed-in user to their own inbox topic; mounted once in the shell. */
export function useInboxLive() {
  const me = useMe();
  const pid = me.data?.principalId;
  useEffect(() => {
    if (!pid) return;
    const topic = `inbox:${pid}`;
    const off = realtime.subscribe(topic);
    const offF = realtime.onFrame((f) => {
      if (f.topic === topic && f.type === "event") void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    });
    return () => {
      off();
      offF();
    };
  }, [pid]);
}
