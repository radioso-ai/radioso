/**
 * The UTC calendar day an Audience Pulse question was asked, `YYYY-MM-DD`: the key the Chat history
 * adapter stamps on each question and the key the report's daily counts are built from.
 */
export const audiencePulseUtcDay = (date: Date): string => date.toISOString().slice(0, 10);
