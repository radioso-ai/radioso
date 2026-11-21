/**
 * The names a skill's author may give the fields it sends: a webhook payload key, an API request
 * parameter. A letter or underscore first, then letters, digits, `_`, `.` and `-`; never a name
 * that would reach an object's prototype when the field is written into a request.
 */
const skillPayloadKeyPattern = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const prototypeKeys = new Set(["__proto__", "constructor", "prototype"]);

/** Whether `key` is a name that would reach an object's prototype. */
export const isPrototypeKey = (key: string): boolean => prototypeKeys.has(key);

export const isSkillPayloadKey = (key: string): boolean =>
  skillPayloadKeyPattern.test(key) && !isPrototypeKey(key);

/** A routine slot or context variable a skill input is collected from. */
export const skillSlotBindingPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
