export interface AppConfig {
  port: number;
  region: string;
}

export declare function parseConfig(source: string): AppConfig;
