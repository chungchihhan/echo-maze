export const BENCHMARK_ID = "echo-maze-benchmark";
export const BENCHMARK_NAME = "Echo Maze Benchmark";
export const BENCHMARK_SHORT_NAME = "EMZ Benchmark";
export const BENCHMARK_THEME = "Memory in Motion";
export const BENCHMARK_FIXTURE_PREFIX = "emz";

/** Present EMZ fixture IDs with consistent display casing. */
export function formatBenchmarkFixtureId(value) {
  return new RegExp(`^${BENCHMARK_FIXTURE_PREFIX}-`, "i").test(value)
    ? value.toUpperCase()
    : value;
}
