/**
 * In-process metrics (§16.1) rendered as Prometheus text. Counters and histograms live in memory per
 * process; database-derived values (lag, backlog, model usage) are added as gauges at scrape time by
 * the ops module. No client library: the format is a few lines of text.
 */
type Labels = Record<string, string>;

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k])}`)
    .join(",");

/** Latency buckets in seconds (HTTP, sandbox). */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

interface Counter {
  kind: "counter";
  help: string;
  values: Map<string, number>;
}
interface Histogram {
  kind: "histogram";
  help: string;
  values: Map<string, { buckets: number[]; sum: number; count: number }>;
}
interface Gauge {
  kind: "gauge";
  help: string;
  values: Map<string, number>;
}

export function createMetrics() {
  const series = new Map<string, Counter | Histogram | Gauge>();

  function counter(name: string, help: string) {
    if (!series.has(name)) series.set(name, { kind: "counter", help, values: new Map() });
    const c = series.get(name) as Counter;
    return {
      inc(labels: Labels = {}, n = 1) {
        const k = key(labels);
        c.values.set(k, (c.values.get(k) ?? 0) + n);
      },
    };
  }

  function histogram(name: string, help: string) {
    if (!series.has(name)) series.set(name, { kind: "histogram", help, values: new Map() });
    const h = series.get(name) as Histogram;
    return {
      observe(labels: Labels, seconds: number) {
        const k = key(labels);
        let v = h.values.get(k);
        if (!v) h.values.set(k, (v = { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }));
        for (const [i, b] of BUCKETS.entries()) if (seconds <= b) v.buckets[i]!++;
        v.sum += seconds;
        v.count++;
      },
    };
  }

  function gauge(name: string, help: string) {
    if (!series.has(name)) series.set(name, { kind: "gauge", help, values: new Map() });
    const g = series.get(name) as Gauge;
    return {
      set(labels: Labels, n: number) {
        g.values.set(key(labels), n);
      },
      add(labels: Labels, n: number) {
        const k = key(labels);
        g.values.set(k, (g.values.get(k) ?? 0) + n);
      },
    };
  }

  /** Prometheus text exposition; `extra` are scrape-time gauges ({name: [{labels, value}]}). */
  function render(extra: Record<string, { help: string; samples: Array<{ labels?: Labels; value: number }> }> = {}) {
    const out: string[] = [];
    const lbl = (k: string, more = "") => (k || more ? `{${[k, more].filter(Boolean).join(",")}}` : "");
    for (const [name, s] of series) {
      out.push(`# HELP ${name} ${s.help}`, `# TYPE ${name} ${s.kind}`);
      if (s.kind === "histogram")
        for (const [k, v] of s.values) {
          for (const [i, b] of BUCKETS.entries()) out.push(`${name}_bucket${lbl(k, `le="${b}"`)} ${v.buckets[i]}`);
          out.push(`${name}_bucket${lbl(k, 'le="+Inf"')} ${v.count}`, `${name}_sum${lbl(k)} ${v.sum}`, `${name}_count${lbl(k)} ${v.count}`);
        }
      else for (const [k, v] of s.values) out.push(`${name}${lbl(k)} ${v}`);
    }
    for (const [name, g] of Object.entries(extra)) {
      out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
      for (const smp of g.samples) out.push(`${name}${lbl(key(smp.labels ?? {}))} ${smp.value}`);
    }
    return `${out.join("\n")}\n`;
  }

  return {
    counter,
    histogram,
    gauge,
    render,
    // The instruments the platform records in-process.
    http: {
      requests: counter("ap_http_requests_total", "HTTP requests by method, route and status"),
      duration: histogram("ap_http_request_duration_seconds", "HTTP request latency by method and route"),
    },
    ws: gauge("ap_ws_connections", "Open WebSocket connections on this instance"),
    sandbox: {
      runs: counter("ap_sandbox_exec_total", "Sandbox executions by sandbox kind and outcome (ok, failed, timeout)"),
      duration: histogram("ap_sandbox_exec_duration_seconds", "Sandbox execution time by sandbox kind"),
    },
  };
}
export type Metrics = ReturnType<typeof createMetrics>;

/** Process-wide registry: one per process, shared by every service instance in it. */
export const metrics = createMetrics();
