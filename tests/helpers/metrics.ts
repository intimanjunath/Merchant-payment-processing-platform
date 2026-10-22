export interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** The samples of a Prometheus text exposition, comments skipped. */
export function parseMetrics(text: string): Sample[] {
  return text.split('\n').flatMap((line) => {
    const match = LINE.exec(line);
    if (!match || line.startsWith('#')) return [];
    const [, name = '', rawLabels = '', value = ''] = match;
    const labels = Object.fromEntries(
      [...rawLabels.matchAll(LABEL)].map(([, key = '', val = '']) => [key, val]),
    );
    return [{ name, labels, value: Number(value) }];
  });
}

/** The value of the one sample with this name whose labels include `labels`; undefined if none. */
export function valueOf(
  samples: Sample[],
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  const matches = samples.filter(
    (sample) =>
      sample.name === name &&
      Object.entries(labels).every(([key, val]) => sample.labels[key] === val),
  );
  if (matches.length > 1)
    throw new Error(`${name} ${JSON.stringify(labels)} matches ${String(matches.length)} samples`);
  return matches[0]?.value;
}
