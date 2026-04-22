type MetricKind = "counter" | "gauge" | "histogram";

export interface MetricWriteOptions {
  help: string;
  labels?: Record<string, string>;
  value?: number;
}

export interface HistogramWriteOptions extends MetricWriteOptions {
  buckets?: number[];
}

interface MetricSeries {
  labels: Record<string, string>;
  value: number;
}

interface HistogramSeries {
  labels: Record<string, string>;
  bucketCounts: number[];
  count: number;
  sum: number;
}

interface HistogramDefinition {
  buckets: number[];
  help: string;
  series: Map<string, HistogramSeries>;
}

const DEFAULT_HISTOGRAM_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000] as const;

const sanitizeMetricName = (name: string): string => {
  const normalized = name
    .trim()
    .replace(/[^a-zA-Z0-9_:]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const prefixed = normalized.startsWith("radioso_") ? normalized : `radioso_${normalized}`;
  return /^[a-zA-Z_:]/.test(prefixed) ? prefixed : `radioso_${prefixed}`;
};

const sanitizeLabelName = (name: string): string =>
  name
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

const normalizeLabels = (labels?: Record<string, string>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(labels ?? {})
      .filter(([, value]) => value.length > 0)
      .map(([key, value]) => [sanitizeLabelName(key), value]),
  );

const serializeLabelKey = (labels: Record<string, string>): string =>
  JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)));

const formatLabelValue = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');

const formatLabels = (labels: Record<string, string>): string => {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return "";
  }

  return `{${entries.map(([key, value]) => `${key}="${formatLabelValue(value)}"`).join(",")}}`;
};

export class MetricsRegistry {
  private readonly counters = new Map<string, { help: string; series: Map<string, MetricSeries> }>();
  private readonly gauges = new Map<string, { help: string; series: Map<string, MetricSeries> }>();
  private readonly histograms = new Map<string, HistogramDefinition>();

  incrementCounter(name: string, options: MetricWriteOptions): void {
    const metricName = sanitizeMetricName(name);
    const metric = this.getOrCreateMetric(this.counters, metricName, options.help);
    const labels = normalizeLabels(options.labels);
    const labelKey = serializeLabelKey(labels);
    const series = metric.series.get(labelKey) ?? {
      labels,
      value: 0,
    };

    series.value += options.value ?? 1;
    metric.series.set(labelKey, series);
  }

  setGauge(name: string, options: MetricWriteOptions): void {
    const metricName = sanitizeMetricName(name);
    const metric = this.getOrCreateMetric(this.gauges, metricName, options.help);
    const labels = normalizeLabels(options.labels);
    metric.series.set(serializeLabelKey(labels), {
      labels,
      value: options.value ?? 0,
    });
  }

  observeHistogram(name: string, options: HistogramWriteOptions): void {
    const metricName = sanitizeMetricName(name);
    const buckets = [...(options.buckets ?? DEFAULT_HISTOGRAM_BUCKETS)].sort((left, right) => left - right);
    const metric = this.histograms.get(metricName) ?? {
      buckets,
      help: options.help,
      series: new Map<string, HistogramSeries>(),
    };
    const labels = normalizeLabels(options.labels);
    const labelKey = serializeLabelKey(labels);
    const series = metric.series.get(labelKey) ?? {
      labels,
      bucketCounts: new Array(metric.buckets.length).fill(0),
      count: 0,
      sum: 0,
    };
    const value = options.value ?? 0;

    for (let index = 0; index < metric.buckets.length; index += 1) {
      if (value <= metric.buckets[index]!) {
        series.bucketCounts[index] += 1;
      }
    }

    series.count += 1;
    series.sum += value;
    metric.series.set(labelKey, series);
    this.histograms.set(metricName, metric);
  }

  renderPrometheus(): string {
    const lines: string[] = [];

    for (const [name, metric] of [...this.counters.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} counter`);
      for (const series of metric.series.values()) {
        lines.push(`${name}${formatLabels(series.labels)} ${series.value}`);
      }
    }

    for (const [name, metric] of [...this.gauges.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} gauge`);
      for (const series of metric.series.values()) {
        lines.push(`${name}${formatLabels(series.labels)} ${series.value}`);
      }
    }

    for (const [name, metric] of [...this.histograms.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`# HELP ${name} ${metric.help}`);
      lines.push(`# TYPE ${name} histogram`);
      for (const series of metric.series.values()) {
        for (let index = 0; index < metric.buckets.length; index += 1) {
          lines.push(
            `${name}_bucket${formatLabels({ ...series.labels, le: String(metric.buckets[index]) })} ${series.bucketCounts[index]}`,
          );
        }
        lines.push(`${name}_bucket${formatLabels({ ...series.labels, le: "+Inf" })} ${series.count}`);
        lines.push(`${name}_sum${formatLabels(series.labels)} ${series.sum}`);
        lines.push(`${name}_count${formatLabels(series.labels)} ${series.count}`);
      }
    }

    return lines.join("\n");
  }

  private getOrCreateMetric(
    registry: Map<string, { help: string; series: Map<string, MetricSeries> }>,
    metricName: string,
    help: string,
  ) {
    const existing = registry.get(metricName);
    if (existing) {
      return existing;
    }

    const created = {
      help,
      series: new Map<string, MetricSeries>(),
    };
    registry.set(metricName, created);
    return created;
  }
}
