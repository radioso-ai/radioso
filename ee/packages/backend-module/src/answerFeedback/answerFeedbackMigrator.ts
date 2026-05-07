import type { ApplicationDatabaseMigrator } from "../radiosoModuleTypes.js";

export const answerFeedbackMigrator: ApplicationDatabaseMigrator = {
  id: "ee-assistant-answer-feedback",
  async migrate(database) {
    await database.query(`
      CREATE TABLE IF NOT EXISTS ee_assistant_answer_feedback (
        id UUID PRIMARY KEY,
        workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        assistant_message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        anonymous_session_id TEXT,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        value TEXT NOT NULL,
        comment TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT ee_assistant_answer_feedback_value_check
          CHECK (value IN ('up', 'down')),
        CONSTRAINT ee_assistant_answer_feedback_actor_type_check
          CHECK (actor_type IN ('authenticated_user', 'api_token', 'anonymous_user')),
        CONSTRAINT ee_assistant_answer_feedback_comment_check
          CHECK (comment IS NULL OR char_length(comment) <= 2000),
        CONSTRAINT ee_assistant_answer_feedback_down_comment_check
          CHECK (value = 'down' OR comment IS NULL)
      )
    `);

    await database.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_assistant_answer_feedback_actor_message
        ON ee_assistant_answer_feedback (assistant_message_id, actor_type, actor_id)
    `);

    await database.query(`
      CREATE INDEX IF NOT EXISTS idx_ee_assistant_answer_feedback_workspace_message
        ON ee_assistant_answer_feedback (workspace_id, assistant_message_id, created_at)
    `);
  },
};
