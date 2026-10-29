// In-memory telemetry history, one time-ordered array per telemetry point.
// Old samples are dropped once a series exceeds `limit` points.

export class HistoryStore {
  constructor(limit) {
    this.limit = limit;
    this.series = new Map();
  }

  add(point) {
    let series = this.series.get(point.id);
    if (!series) {
      series = [];
      this.series.set(point.id, series);
    }

    // Samples almost always arrive in order; insert in place if one doesn't.
    if (series.length === 0 || series[series.length - 1].timestamp <= point.timestamp) {
      series.push(point);
    } else {
      series.splice(lowerBound(series, point.timestamp), 0, point);
    }

    // Trim in chunks so we aren't shifting the array on every sample.
    if (series.length > this.limit * 1.1) {
      series.splice(0, series.length - this.limit);
    }
  }

  query(id, start, end, { latest = false } = {}) {
    const series = this.series.get(id) ?? [];
    const from = lowerBound(series, start);
    const to = lowerBound(series, end + 1);

    if (latest) {
      return to > from ? [series[to - 1]] : [];
    }
    return series.slice(from, to);
  }
}

// Index of the first sample with timestamp >= t.
function lowerBound(series, t) {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid].timestamp < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
