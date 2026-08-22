import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const replayRuns = sqliteTable("replay_runs", {
  id: text("id").primaryKey(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  status: text("status").notNull(),
  model: text("model").notNull(),
  mazeSeed: text("maze_seed").notNull(),
  mazeJson: text("maze_json").notNull(),
  initialPositionJson: text("initial_position_json").notNull(),
});

export const replayEvents = sqliteTable(
  "replay_events",
  {
    runId: text("run_id").notNull(),
    sequence: integer("sequence").notNull(),
    createdAt: integer("created_at").notNull(),
    turn: integer("turn").notNull(),
    phase: text("phase").notNull(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
  },
  (table) => [primaryKey({ columns: [table.runId, table.sequence] })],
);
