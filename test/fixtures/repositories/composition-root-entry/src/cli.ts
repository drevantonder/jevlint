import { Db, getDatabase } from "./db.js";
import { PostgresStore } from "./store.js";

export type CliStreams = {
  cwd: string;
  stdout: { write: (text: string) => void };
  stderr: { write: (text: string) => void };
};

export function runCli(args: string[], streams: CliStreams): number {
  const store = new PostgresStore(streams.cwd);
  const verbose = args.includes("--verbose");
  const db = Db.getInstance();
  const legacy = getDatabase();
  const saved = store.save({ verbose, db, legacy });
  streams.stdout.write(`saved ${saved}\n`);
  return saved;
}

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdout: process.stdout,
  stderr: process.stderr,
});
