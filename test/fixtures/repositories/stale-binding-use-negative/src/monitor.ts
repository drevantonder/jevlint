export type MonitorConfig = {
  interval: number;
  display: string;
};

export type Monitor = {
  config: MonitorConfig;
};

export function currentConfig(monitor: Monitor, display: string): MonitorConfig {
  const updated = { ...monitor.config, display };
  return updated;
}
